import type { ElementHandle as CoreElementHandle, Page as CorePage, CDPSession as CoreCDPSession, Frame as CoreFrame } from 'patchright-core' // Assuming patchright-core has Frame type
import type { ElementHandle as PlaywrightElementHandle, Page as PlaywrightPage, CDPSession as PlaywrightCDPSession, Frame as PlaywrightFrame } from 'playwright-core'
import debug from 'debug'
import {
    type Vector,
    type TimedVector,
    bezierCurve,
    direction,
    magnitude,
    origin,
    overshoot,
    addNoise,
    easeInOutCubic
} from './math'
export { default as installMouseHelper } from './mouse-helper'
export { type Vector } from './math'

const log = debug('ghost-cursor')

// Combine types for easier usage
type Page = CorePage | PlaywrightPage
type Frame = CoreFrame | PlaywrightFrame
type ElementHandle<T extends Node = Node> = CoreElementHandle<T> | PlaywrightElementHandle<T>
type CDPSession = CoreCDPSession | PlaywrightCDPSession

// --- Interfaces with additions ---
export interface BoundingBox {
    x: number
    y: number
    width: number
    height: number
}

export interface BoxOptions {
    readonly paddingPercentage?: number
}

export interface MoveOptions extends BoxOptions, Pick<PathOptions, 'moveSpeed'> {
    readonly waitForSelector?: number
    readonly moveDelay?: number
    readonly randomizeMoveDelay?: boolean
    readonly maxTries?: number
    readonly overshootThreshold?: number
}

export interface ClickOptions extends MoveOptions {
    readonly waitForClick?: number
    readonly microJitter?: boolean // New: add small jitter before click
    readonly dynamicAdjustment?: boolean // New: Enable adjustment for moving elements
}

export interface PathOptions {
    readonly spreadOverride?: number
    readonly moveSpeed?: number
    readonly useTimestamps?: boolean
    readonly noiseScale?: number // New: scale for path noise
    readonly endpointNoise?: boolean // New: Apply noise to endpoints? Default false for reliability
}

export interface RandomMoveOptions extends Pick<MoveOptions, 'moveDelay' | 'randomizeMoveDelay' | 'moveSpeed'> { }

export interface MoveToOptions extends PathOptions, Pick<MoveOptions, 'moveDelay' | 'randomizeMoveDelay'> { }

// This is the public interface that will be returned
export interface GhostCursor {
    toggleRandomMove: (random: boolean) => void
    click: (selector?: string, options?: ClickOptions) => Promise<void>
    move: (selector: string, options?: MoveOptions) => Promise<void>
    moveTo: (destination: Vector, options?: MoveToOptions) => Promise<void>
    getLocation: () => Vector
}

/** Helper function to wait a specified number of milliseconds */
const delay = async (ms: number): Promise<void> => {
    if (ms < 1) return
    return await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calculate the amount of time needed to move from (x1, y1) to (x2, y2)
 * given the width of the element being clicked on
 * https://en.wikipedia.org/wiki/Fitts%27s_law
 */
const fitts = (distance: number, width: number): number => {
    const a = 0
    const b = 2
    const ratio = Math.max(distance / Math.max(width, 1), 0)
    const id = Math.log2(ratio + 1)
    return a + b * id
}

/** Get a random point on a box */
const getRandomBoxPoint = (
    { x, y, width, height }: BoundingBox,
    options?: BoxOptions
): Vector => {
    let paddingWidth = 0
    let paddingHeight = 0

    if (
        options?.paddingPercentage !== undefined &&
        options.paddingPercentage >= 0 &&
        options.paddingPercentage <= 100
    ) {
        paddingWidth = (width * options.paddingPercentage) / 100
        paddingHeight = (height * options.paddingPercentage) / 100
    }

    const effectiveWidth = Math.max(0, width - paddingWidth)
    const effectiveHeight = Math.max(0, height - paddingHeight)

    return {
        x: x + paddingWidth / 2 + Math.random() * effectiveWidth,
        y: y + paddingHeight / 2 + Math.random() * effectiveHeight
    }
}

/** Updated helper to create a CDP session in Playwright - Always uses Page */
const getCDPClient = async (page: Page): Promise<CDPSession> => {
    return await page.context().newCDPSession(page as PlaywrightPage)
}

/** Get a random point on a browser page using viewport size - Always uses Page */
export const getRandomPagePoint = async (page: Page): Promise<Vector> => {
    let viewport = page.viewportSize()
    if (viewport == null) {
        viewport = await page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight
        }))
        if (viewport == null) {
            throw new Error('Could not get viewport size')
        }
    }
    return getRandomBoxPoint({
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height
    })
}

/** Get the bounding box of an element relative to the main frame using boundingBox */
const getElementBox = async (
    element: ElementHandle<Element>
): Promise<BoundingBox | null> => {
    return await element.boundingBox()
}

const boundingBoxWithFallback = async (
    elem: ElementHandle<Element>
): Promise<BoundingBox> => {
    let box = await getElementBox(elem)
    if (box == null) {
        try {
            log('Element has no bounding box, attempting scrollIntoViewIfNeeded.')
            await elem.scrollIntoViewIfNeeded({ timeout: 2000 })
            await delay(100)
            box = await getElementBox(elem)
            if (box != null) {
                log('Bounding box found after scrolling.')
                return box
            }
        } catch (scrollError: unknown) {
            const message = scrollError instanceof Error ? scrollError.message : String(scrollError)
            log('Could not scroll element into view or find box after scroll:', message)
        }
        throw new Error('Element is not visible or does not have a bounding box after attempting to scroll')
    }
    return box
}

// --- Path generation functions ---
export function path(point: Vector, target: Vector, options?: number | PathOptions): Vector[] | TimedVector[]
export function path(point: Vector, target: BoundingBox, options?: number | PathOptions): Vector[] | TimedVector[]
export function path(start: Vector, end: BoundingBox | Vector, options?: number | PathOptions): Vector[] | TimedVector[] {
    const optionsResolved: PathOptions = typeof options === 'number'
        ? { spreadOverride: options, noiseScale: 1.5, endpointNoise: false }
        : { noiseScale: 1.5, endpointNoise: false, ...options } // Default noise
    const DEFAULT_WIDTH = 100
    const MIN_STEPS = 25
    const width = typeof end === 'object' && 'width' in end && end.width !== 0 ? end.width : DEFAULT_WIDTH
    const curve = bezierCurve(start, end, optionsResolved.spreadOverride)
    const length = curve.length() * 0.8

    const speedFactor = optionsResolved.moveSpeed !== undefined && optionsResolved.moveSpeed > 0
        ? 1 / optionsResolved.moveSpeed
        : 1

    const baseTime = MIN_STEPS
    const fittsID = fitts(length, width)
    const steps = Math.ceil(Math.max(MIN_STEPS, (baseTime + fittsID * 5) * speedFactor)) // Ensure min steps

    const re = curve.getLUT(steps)
    return clampPositive(re, optionsResolved)
}

const clampPositive = (vectors: Vector[], options?: PathOptions): Vector[] | TimedVector[] => {
    const noiseScale = options?.noiseScale ?? 0
    const noisedVectors = vectors.map((vector, index) => {
        const isEndpoint = index === 0 || index === vectors.length - 1
        if (noiseScale > 0 && ((options?.endpointNoise ?? false) || !isEndpoint)) {
            return addNoise(vector, noiseScale)
        }
        return vector
    })
    const clampedVectors = noisedVectors.map((vector) => ({
        x: Math.max(0, vector.x),
        y: Math.max(0, vector.y)
    }))

    return options?.useTimestamps === true ? generateTimestamps(clampedVectors, options) : clampedVectors
}

const generateTimestamps = (vectors: Vector[], options?: PathOptions): TimedVector[] => {
    const DEFAULT_MOVE_SPEED = 1
    const moveSpeed = options?.moveSpeed ?? DEFAULT_MOVE_SPEED
    const totalSteps = vectors.length

    const avgTimePerStep = 15 / Math.max(moveSpeed, 0.1)
    const totalDuration = totalSteps * avgTimePerStep

    const timedVectors: TimedVector[] = []
    const startTime = Date.now()

    if (totalSteps <= 1) {
        return totalSteps === 1 ? [{ ...vectors[0], timestamp: startTime }] : []
    }

    for (let i = 0; i < totalSteps; i++) {
        const progress = i / (totalSteps - 1)
        const easedProgress = easeInOutCubic(progress)
        const timestamp = startTime + Math.round(easedProgress * totalDuration)
        timedVectors.push({ ...vectors[i], timestamp })
    }
    return timedVectors
}

const shouldOvershoot = (a: Vector, b: Vector, threshold: number): boolean =>
    magnitude(direction(a, b)) > threshold

const intersectsElement = (vec: Vector, box: BoundingBox): boolean => {
    return (
        vec.x >= box.x &&
        vec.x <= box.x + box.width &&
        vec.y >= box.y &&
        vec.y <= box.y + box.height
    )
}

export const createCursor = (
    page: Page,
    start: Vector = origin,
    performRandomMovesInitially: boolean = false,
    defaultOptions: {
        randomMove?: RandomMoveOptions
        move?: MoveOptions
        moveTo?: MoveToOptions
        click?: ClickOptions
    } = {},
    frame: Frame | null = null
): GhostCursor => {
    const OVERSHOOT_SPREAD = 10
    const OVERSHOOT_RADIUS = 120
    let previous: Vector = start
    let isMoving: boolean = false
    let isPerformingRandomMoves: boolean = performRandomMovesInitially
    let randomMoveTimeoutId: NodeJS.Timeout | null = null

    const context: Page | Frame = frame ?? page

    let cdpClientPromise: Promise<CDPSession> | null = null
    const getOrCreateCDPClient = async (): Promise<CDPSession> => {
        if (cdpClientPromise == null) {
            cdpClientPromise = getCDPClient(page).catch(err => {
                log('Failed to create CDP Client', err)
                cdpClientPromise = null
                throw err
            })
        }
        return await cdpClientPromise
    }

    const tracePath = async (
        vectors: Iterable<Vector | TimedVector>,
        abortOnMove: boolean = false
    ): Promise<void> => {
        isMoving = true
        try {
            const cdpClient = await getOrCreateCDPClient()
            for (const v of vectors) {
                if (page.isClosed()) {
                    log('Page closed during tracePath, aborting.')
                    isMoving = false
                    return
                }

                try {
                    const dispatchParams: any = {
                        type: 'mouseMoved',
                        x: v.x,
                        y: v.y
                    }

                    if ('timestamp' in v && typeof v.timestamp === 'number' && v.timestamp > 0) {
                        dispatchParams.timestamp = v.timestamp / 1000
                    }

                    await cdpClient.send('Input.dispatchMouseEvent', dispatchParams)
                    previous = { x: v.x, y: v.y }
                } catch (error: unknown) {
                    const isError = error instanceof Error
                    const errorMessage = isError ? error.message : String(error)
                    if (page.isClosed() || (isError && (errorMessage.includes('Target closed') || errorMessage.includes('Session closed')))) {
                        log('Warning: could not move mouse, page or session closed.')
                        isMoving = false
                        return
                    }
                    log('Warning: could not move mouse, error message:', errorMessage)
                }
            }
        } catch (error) {
            log('Error during tracePath setup or execution:', error)
        } finally {
            if (isMoving) {
                isMoving = false
            }
        }
    }

    const _toggleRandomMove = (random: boolean): void => {
        if (isPerformingRandomMoves !== random) {
            isPerformingRandomMoves = random
            if (random) {
                log('Random moves enabled')
                _scheduleRandomMove(defaultOptions?.randomMove)
            } else {
                log('Random moves disabled')
                if (randomMoveTimeoutId != null) {
                    clearTimeout(randomMoveTimeoutId)
                    randomMoveTimeoutId = null
                }
            }
        }
    }

    const _scheduleRandomMove = (options?: RandomMoveOptions): void => {
        if (randomMoveTimeoutId != null) {
            clearTimeout(randomMoveTimeoutId)
        }
        if (!isPerformingRandomMoves || isMoving) {
            return
        }

        const optionsResolved: RandomMoveOptions = {
            moveDelay: 2000,
            randomizeMoveDelay: true,
            moveSpeed: 0.8,
            ...defaultOptions?.randomMove,
            ...options
        }

        const delayTime = (optionsResolved.moveDelay ?? 0) * ((optionsResolved.randomizeMoveDelay ?? false) ? (0.5 + Math.random() * 0.5) : 1)

        randomMoveTimeoutId = setTimeout(() => {
            if (!isPerformingRandomMoves || isMoving || page.isClosed()) {
                return
            }
            const performRandomMove = async (): Promise<void> => {
                try {
                    const randPoint = await getRandomPagePoint(page)
                    log(`Performing random move to ${JSON.stringify(randPoint)}`)
                    await actions.moveTo(randPoint, {
                        moveSpeed: optionsResolved.moveSpeed,
                        moveDelay: 0,
                        randomizeMoveDelay: false
                    })
                    if (isPerformingRandomMoves) {
                        _scheduleRandomMove(options)
                    }
                } catch (error: unknown) {
                    if (!page.isClosed()) {
                        const message = error instanceof Error ? error.message : String(error)
                        log('Warning: failed during random move, stopping random moves.', message)
                        _toggleRandomMove(false)
                    }
                }
            }
            performRandomMove().catch((error) => {
                log('Error in random move:', error)
            })
        }, delayTime)
    }

    const _startAction = async (): Promise<boolean> => {
        const wasRandomActive = isPerformingRandomMoves
        if (wasRandomActive) {
            _toggleRandomMove(false)
        }
        if (randomMoveTimeoutId != null) {
            clearTimeout(randomMoveTimeoutId)
            randomMoveTimeoutId = null
        }
        isMoving = true
        return wasRandomActive
    }

    const _endAction = async (
        wasRandomActive: boolean,
        moveDelayOptions: { moveDelay?: number, randomizeMoveDelay?: boolean }
    ): Promise<void> => {
        isMoving = false
        const delayTime = (moveDelayOptions.moveDelay ?? 0) * ((moveDelayOptions.randomizeMoveDelay ?? false) ? Math.random() : 1)
        await delay(delayTime)
        if (wasRandomActive && !isMoving) {
            _toggleRandomMove(true)
        }
    }



    const actions: GhostCursor = {
        toggleRandomMove: _toggleRandomMove,

        getLocation(): Vector {
            return previous
        },

        async click(
            selector?: string,
            options?: ClickOptions
        ): Promise<void> {
            const optionsResolved: ClickOptions = {
                waitForClick: 50,
                paddingPercentage: 10,
                moveDelay: 0,
                randomizeMoveDelay: true,
                waitForSelector: 10000,
                maxTries: 3,
                overshootThreshold: 500,
                moveSpeed: 1,
                microJitter: true,
                dynamicAdjustment: true, // New: Enable adjustment for moving elements
                ...defaultOptions?.move,
                ...defaultOptions?.click,
                ...options
            }

            const wasRandom = await _startAction()

            try {
                const cdpClient = await getOrCreateCDPClient()
                if (selector != null) {
                    log(`Clicking element: ${selector}`)

                    await actions.move(selector, {
                        waitForSelector: optionsResolved.waitForSelector,
                        paddingPercentage: optionsResolved.paddingPercentage,
                        moveSpeed: optionsResolved.moveSpeed,
                        maxTries: optionsResolved.maxTries,
                        overshootThreshold: optionsResolved.overshootThreshold,
                        moveDelay: 0,
                        randomizeMoveDelay: false
                    })

                    const targetPoint = previous

                    const locator = context.locator(selector)
                    await locator.waitFor({ state: 'visible', timeout: optionsResolved.waitForSelector })

                    const boundingBox = await locator.boundingBox()
                    if (boundingBox == null) {
                        throw new Error(`Element ${selector} has no bounding box right before click`)
                    }

                    const offset = {
                        x: targetPoint.x - boundingBox.x,
                        y: targetPoint.y - boundingBox.y
                    }

                    // Normalize offset to relative (0-1 range) for flexibility
                    const relOffset = {
                        x: offset.x / boundingBox.width,
                        y: offset.y / boundingBox.height
                    }

                    if (offset.x < 0 || offset.x > boundingBox.width ||
                        offset.y < 0 || offset.y > boundingBox.height) {
                        log(`Warning: Cursor at ${JSON.stringify(targetPoint)} is outside element bounds ${JSON.stringify(boundingBox)}`)
                        const clampedOffset = {
                            x: Math.max(0, Math.min(offset.x, boundingBox.width)),
                            y: Math.max(0, Math.min(offset.y, boundingBox.height))
                        }
                        log(`Using clamped offset: ${JSON.stringify(clampedOffset)}`)
                        offset.x = clampedOffset.x
                        offset.y = clampedOffset.y
                    } else {
                        log(`Performing click on element at exact cursor offset ${JSON.stringify(offset)}`)
                    }



                    // Refetch box if dynamic adjustment enabled (for moving elements)
                    let finalBox = boundingBox
                    let finalClickPoint = { x: boundingBox.x + offset.x, y: boundingBox.y + offset.y }
                    if (optionsResolved.dynamicAdjustment === true) {
                        const newBox = await locator.boundingBox()
                        if (newBox !== null) {
                            finalBox = newBox
                            finalClickPoint = {
                                x: finalBox.x + relOffset.x * finalBox.width,
                                y: finalBox.y + relOffset.y * finalBox.height
                            }
                            // Trace a short correction path if shifted (keep human-like with mini-Bezier)
                            if (magnitude(direction(previous, finalClickPoint)) > 5) { // Threshold for minor shifts
                                await tracePath(path(previous, finalClickPoint, { moveSpeed: (optionsResolved.moveSpeed ?? 1) * 1.5, noiseScale: 0.5 }))
                            }
                        }
                    }

                    await tracePath([{ x: finalClickPoint.x, y: finalClickPoint.y }]) // Ensure at final point
                    await cdpClient.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: finalClickPoint.x, y: finalClickPoint.y, button: 'left', clickCount: 1 })
                    await delay(optionsResolved.waitForClick ?? 0)
                    await cdpClient.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: finalClickPoint.x, y: finalClickPoint.y, button: 'left', clickCount: 1 })
                } else {
                    log(`Performing click at current location: ${JSON.stringify(previous)}`)

                    await cdpClient.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: previous.x, y: previous.y, button: 'left', clickCount: 1 })
                    await delay(optionsResolved.waitForClick ?? 0)
                    await cdpClient.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: previous.x, y: previous.y, button: 'left', clickCount: 1 })
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error)
                log('Error: could not perform click, error message:', errorMessage)
                throw new Error(`Failed to click ${(selector != null) ? selector : 'current location'}. Error: ${errorMessage}`)
            } finally {
                await _endAction(wasRandom, optionsResolved)
            }
        },

        async move(
            selector: string,
            options?: MoveOptions
        ): Promise<void> {
            const optionsResolved: MoveOptions = {
                maxTries: 3,
                overshootThreshold: 500,
                paddingPercentage: 25,
                moveDelay: 0,
                randomizeMoveDelay: true,
                waitForSelector: 10000,
                moveSpeed: 1,
                ...defaultOptions?.move,
                ...options
            }

            const wasRandom = await _startAction()
            let success = false
            let lastError: Error | null = null

            try {
                const go = async (iteration: number): Promise<boolean> => {
                    if (page.isClosed()) {
                        log('Page closed during move, aborting.')
                        return false
                    }
                    if (iteration >= (optionsResolved.maxTries ?? 3)) {
                        log(`Could not move to element within ${optionsResolved.maxTries ?? 3} tries.`)
                        lastError = new Error(`Could not mouse-over element within ${optionsResolved.maxTries ?? 3} tries`)
                        return false
                    }

                    log(`Move attempt ${(iteration + 1).toString()} for selector: ${selector}`)

                    let elem: ElementHandle<Element> | null = null
                    try {
                        elem = await context.waitForSelector(selector, {
                            state: 'visible',
                            timeout: optionsResolved.waitForSelector
                        }) as ElementHandle<Element>

                        await elem.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(scrollError => {
                            log('Warning: could not scroll element into view:', scrollError)
                        })
                        await delay(100)

                        const box = await boundingBoxWithFallback(elem)
                        const { height, width } = box
                        const destination = getRandomBoxPoint(box, { paddingPercentage: optionsResolved.paddingPercentage })
                        const dimensions = { height, width }

                        log(`Target element box: ${JSON.stringify(box)}, moving to point: ${JSON.stringify(destination)}`)

                        const overshooting = shouldOvershoot(previous, destination, optionsResolved.overshootThreshold ?? 500)
                        const targetPoint = overshooting ? overshoot(destination, OVERSHOOT_RADIUS) : destination

                        await tracePath(path(previous, targetPoint, optionsResolved), false)

                        if (overshooting) {
                            log('Overshooting, correcting path...')
                            const correction = path(targetPoint, { ...dimensions, ...destination }, {
                                spreadOverride: OVERSHOOT_SPREAD,
                                moveSpeed: optionsResolved.moveSpeed
                            })
                            await tracePath(correction, false)
                        }

                        const finalPos = previous
                        const finalBox = await getElementBox(elem)

                        if ((finalBox != null) && intersectsElement(finalPos, finalBox)) {
                            log(`Successfully moved over element: ${selector}`)
                            return true
                        } else {
                            // Poll and correct up to 2 times
                            for (let poll = 1; poll <= 2; poll++) {
                                await delay(50 + Math.random() * 100) // Human-like pause
                                const pollBox = await getElementBox(elem)
                                if ((pollBox != null) && intersectsElement(previous, pollBox)) {
                                    log(`Successfully moved over element on poll attempt: ${poll}`)
                                    return true
                                }
                                // Short correction path
                                if (pollBox != null) {
                                    const correctionTarget = getRandomBoxPoint(pollBox, { paddingPercentage: optionsResolved.paddingPercentage })
                                    await tracePath(path(previous, correctionTarget, { spreadOverride: 5, moveSpeed: (optionsResolved.moveSpeed ?? 1) * 2 }))
                                }
                            }

                            log(`Move completed, but cursor at ${JSON.stringify(finalPos)} is not over the element's final box: ${JSON.stringify(finalBox)}. Retrying...`)
                            lastError = new Error(`Cursor position ${JSON.stringify(finalPos)} does not intersect element box ${JSON.stringify(finalBox)}`)
                            return await go(iteration + 1)
                        }
                    } catch (error: unknown) {
                        lastError = error instanceof Error ? error : new Error(String(error))
                        log(`Error during move attempt ${(iteration + 1).toString()}:`, lastError.message)
                        await delay(200 + Math.random() * 300)
                        return await go(iteration + 1)
                    }
                }

                success = await go(0)
                if (!success && lastError !== null) {
                    throw lastError
                }
            } finally {
                await _endAction(wasRandom, optionsResolved)
                if (!success) {
                    log(`Move action failed for selector: ${selector}`)
                }
            }
        },

        async moveTo(destination: Vector, options?: MoveToOptions): Promise<void> {
            const optionsResolved: MoveToOptions = {
                moveDelay: 0,
                randomizeMoveDelay: true,
                moveSpeed: 1,
                ...defaultOptions?.moveTo,
                ...options
            }

            const wasRandom = await _startAction()

            try {
                log(`Moving to absolute position: ${JSON.stringify(destination)}`)
                await tracePath(path(previous, destination, optionsResolved), false)
            } catch (error) {
                log('Error during moveTo:', error)
                throw new Error(`moveTo failed: ${String(error)}`)
            } finally {
                await _endAction(wasRandom, optionsResolved)
            }
        }
    }

    if (isPerformingRandomMoves) {
        _scheduleRandomMove(defaultOptions?.randomMove)
    }

    return actions
}
