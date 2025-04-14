import type { ElementHandle, Page, CDPSession } from 'patchright-core'
import type { ElementHandle as PlaywrightElementHandle, Page as PlaywrightPage, CDPSession as PlaywrightCDPSession } from 'playwright-core'
import debug from 'debug'
import {
  type Vector,
  type TimedVector,
  bezierCurve,
  bezierCurveSpeed,
  direction,
  magnitude,
  origin,
  overshoot
} from './math'
export { default as installMouseHelper } from './mouse-helper'
export { type Vector } from './math'

const log = debug('ghost-cursor')

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
  readonly hesitate?: number
  readonly waitForClick?: number
  readonly moveDelay?: number
}

export interface PathOptions {
  readonly spreadOverride?: number
  readonly moveSpeed?: number
  readonly useTimestamps?: boolean
}

export interface RandomMoveOptions extends Pick<MoveOptions, 'moveDelay' | 'randomizeMoveDelay' | 'moveSpeed'> {
  readonly moveDelay?: number
}

export interface MoveToOptions extends PathOptions, Pick<MoveOptions, 'moveDelay' | 'randomizeMoveDelay'> {
  readonly moveDelay?: number
}

export interface GhostCursor {
  toggleRandomMove: (random: boolean) => void
  click: (selector?: string | ElementHandle | PlaywrightElementHandle, options?: ClickOptions) => Promise<void>
  move: (selector: string | ElementHandle | PlaywrightElementHandle, options?: MoveOptions) => Promise<void>
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
  const id = Math.log2(distance / width + 1)
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
    options.paddingPercentage > 0 &&
    options.paddingPercentage <= 100
  ) {
    paddingWidth = (width * options.paddingPercentage) / 100
    paddingHeight = (height * options.paddingPercentage) / 100
  }

  return {
    x: x + paddingWidth / 2 + Math.random() * (width - paddingWidth),
    y: y + paddingHeight / 2 + Math.random() * (height - paddingHeight)
  }
}

/** Updated helper to create a CDP session in Playwright */
const getCDPClient = async (page: Page | PlaywrightPage): Promise<CDPSession | PlaywrightCDPSession> => {
  return await page.context().newCDPSession(page)
}

/** Get a random point on a browser page using viewport size instead of CDP target */
export const getRandomPagePoint = async (page: Page | PlaywrightPage): Promise<Vector> => {
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

export function path(point: Vector, target: Vector, options?: number | PathOptions): Vector[] | TimedVector[]
export function path(point: Vector, target: BoundingBox, options?: number | PathOptions): Vector[] | TimedVector[]
export function path(start: Vector, end: BoundingBox | Vector, options?: number | PathOptions): Vector[] | TimedVector[] {
  const optionsResolved: PathOptions = typeof options === 'number'
    ? { spreadOverride: options }
    : { ...options }
  const DEFAULT_WIDTH = 100
  const MIN_STEPS = 25
  const width = 'width' in end && end.width !== 0 ? end.width : DEFAULT_WIDTH
  const curve = bezierCurve(start, end, optionsResolved.spreadOverride)
  const length = curve.length() * 0.8

  const speed = optionsResolved.moveSpeed !== undefined && optionsResolved.moveSpeed > 0
    ? (25 / optionsResolved.moveSpeed)
    : Math.random()
  const baseTime = speed * MIN_STEPS
  const steps = Math.ceil((Math.log2(fitts(length, width) + 1) + baseTime) * 3)
  const re = curve.getLUT(steps)
  return clampPositive(re, optionsResolved)
}

const clampPositive = (vectors: Vector[], options?: PathOptions): Vector[] | TimedVector[] => {
  const clampedVectors = vectors.map((vector) => ({
    x: Math.max(0, vector.x),
    y: Math.max(0, vector.y)
  }))

  return options?.useTimestamps === true ? generateTimestamps(clampedVectors, options) : clampedVectors
}

const generateTimestamps = (vectors: Vector[], options?: PathOptions): TimedVector[] => {
  const speed = options?.moveSpeed ?? (Math.random() * 0.5 + 0.5)
  const timeToMove = (P0: Vector, P1: Vector, P2: Vector, P3: Vector, samples: number): number => {
    let total = 0
    const dt = 1 / samples

    for (let t = 0; t < 1; t += dt) {
      const v1 = bezierCurveSpeed(t * dt, P0, P1, P2, P3)
      const v2 = bezierCurveSpeed(t, P0, P1, P2, P3)
      total += (v1 + v2) * dt / 2
    }

    return Math.round(total / speed)
  }

  const timedVectors: TimedVector[] = vectors.map((vector) => ({ ...vector, timestamp: 0 }))

  for (let i = 0; i < timedVectors.length; i++) {
    const P0 = i === 0 ? timedVectors[i] : timedVectors[i - 1]
    const P1 = timedVectors[i]
    const P2 = i === timedVectors.length - 1 ? timedVectors[i] : timedVectors[i + 1]
    const P3 = i === timedVectors.length - 1 ? timedVectors[i] : timedVectors[i + 1]
    const time = timeToMove(P0, P1, P2, P3, timedVectors.length)

    timedVectors[i] = {
      ...timedVectors[i],
      timestamp: i === 0 ? Date.now() : timedVectors[i - 1].timestamp + time
    }
  }

  return timedVectors
}

const shouldOvershoot = (a: Vector, b: Vector, threshold: number): boolean =>
  magnitude(direction(a, b)) > threshold

const intersectsElement = (vec: Vector, box: BoundingBox): boolean => {
  return (
    vec.x > box.x &&
    vec.x <= box.x + box.width &&
    vec.y > box.y &&
    vec.y <= box.y + box.height
  )
}

const boundingBoxWithFallback = async (
  elem: ElementHandle<Element>
): Promise<BoundingBox> => {
  const box = await getElementBox(elem)
  if (box == null) {
    throw new Error('Element is not visible')
  }
  return box
}

export const createCursor = (
  page: Page | PlaywrightPage,
  start: Vector = origin,
  performRandomMoves: boolean = false,
  defaultOptions: {
    randomMove?: RandomMoveOptions
    move?: MoveOptions
    moveTo?: MoveToOptions
    click?: ClickOptions
  } = {}
): GhostCursor => {
  const OVERSHOOT_SPREAD = 10
  const OVERSHOOT_RADIUS = 120
  let previous: Vector = start
  let moving: boolean = false

  const tracePath = async (
    vectors: Iterable<Vector | TimedVector>,
    abortOnMove: boolean = false
  ): Promise<void> => {
    const cdpClient = await getCDPClient(page)

    for (const v of vectors) {
      try {
        if (abortOnMove && moving) {
          return
        }

        const dispatchParams: any = {
          type: 'mouseMoved',
          x: v.x,
          y: v.y
        }

        if ('timestamp' in v) {
          dispatchParams.timestamp = v.timestamp
        }

        await cdpClient.send('Input.dispatchMouseEvent', dispatchParams)
        previous = v
      } catch (error) {
        if (page.isClosed()) return
        log('Warning: could not move mouse, error message:', error)
      }
    }
  }

  const randomMove = async (options?: RandomMoveOptions): Promise<void> => {
    const optionsResolved: RandomMoveOptions = {
      moveDelay: 2000,
      randomizeMoveDelay: true,
      ...defaultOptions?.randomMove,
      ...options
    }

    try {
      if (!moving) {
        const rand = await getRandomPagePoint(page)
        await tracePath(path(previous, rand, optionsResolved), true)
        previous = rand
      }
      await delay((optionsResolved.moveDelay ?? 0) * ((optionsResolved.randomizeMoveDelay ?? false) ? Math.random() : 1))
      randomMove(options).catch(() => { })
    } catch (_) {
      log('Warning: stopping random mouse movements')
    }
  }

  const actions: GhostCursor = {
    toggleRandomMove(random: boolean): void {
      moving = !random
    },

    getLocation(): Vector {
      return previous
    },

    async click(
      selector?: string | ElementHandle | PlaywrightElementHandle,
      options?: ClickOptions
    ): Promise<void> {
      const optionsResolved: ClickOptions = {
        moveDelay: 2000,
        hesitate: 0,
        waitForClick: 0,
        randomizeMoveDelay: true,
        ...defaultOptions?.click,
        ...options
      }

      const wasRandom = !moving
      actions.toggleRandomMove(false)

      let element: ElementHandle<HTMLElement>
      try {
        if (selector !== undefined) {
          if (typeof selector === 'string') {
            element = await page.waitForSelector(selector, { timeout: 5000 }) as ElementHandle<HTMLElement>
          } else {
            element = selector as ElementHandle<HTMLElement>
          }

          const boundingBox = await element.boundingBox()
          if (boundingBox == null) throw new Error('Unable to retrieve bounding box of the element')

          try {
            await actions.move(element, { paddingPercentage: 75, ...optionsResolved, moveDelay: 0 })
          } catch {
            await actions.moveTo(boundingBox, optionsResolved)
          }

          const cursorPos = actions.getLocation()
          const offset = {
            x: cursorPos.x - boundingBox.x,
            y: cursorPos.y - boundingBox.y
          }

          await element.hover({ force: true, position: offset })
          await delay(100)

          const performClick = async (clickFunc: () => Promise<void>): Promise<void> => {
            await clickFunc()
            await page.waitForLoadState('load', { timeout: 5000 })
          }

          try {
            await performClick(async () =>
              await element.click({
                force: true,
                position: offset,
                delay: optionsResolved.waitForClick ?? 0,
                timeout: 1500
              })
            )
          } catch (e) {
            await performClick(async () => await element.evaluate((el) => el.click()))
          }
        } else {
          const clickOptions = optionsResolved.waitForClick != null
            ? { delay: optionsResolved.waitForClick }
            : undefined
          const location = actions.getLocation()
          await page.mouse.click(location.x, location.y, clickOptions)
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log('Warning: could not perform click, error message:', errorMessage)
        throw new Error(`Failed to click element: ${selector?.toString() ?? 'unknown'}. Error: ${errorMessage}`)
      } finally {
        await delay(
          (optionsResolved.moveDelay ?? 0) *
          ((optionsResolved.randomizeMoveDelay ?? false) ? Math.random() : 1)
        )
        actions.toggleRandomMove(wasRandom)
      }
    },

    async move(
      selector: string | ElementHandle | PlaywrightElementHandle,
      options?: MoveOptions
    ): Promise<void> {
      const optionsResolved: MoveOptions = {
        moveDelay: 0,
        maxTries: 10,
        overshootThreshold: 500,
        randomizeMoveDelay: true,
        ...defaultOptions?.move,
        ...options
      }

      const wasRandom = !moving

      const go = async (iteration: number): Promise<void> => {
        if (iteration > (optionsResolved.maxTries ?? 10)) {
          throw Error('Could not mouse-over element within enough tries')
        }

        actions.toggleRandomMove(false)
        let elem: ElementHandle<Element> | null = null
        if (typeof selector === 'string') {
          if (selector.startsWith('//') || selector.startsWith('(//')) {
            const xpathSelector = `xpath=${selector}`
            if (optionsResolved.waitForSelector !== undefined) {
              await page.waitForSelector(xpathSelector, {
                timeout: optionsResolved.waitForSelector
              })
            }
            const [handle] = await page.$$(selector)
            elem = handle.asElement() as ElementHandle<Element>
          } else {
            if (optionsResolved.waitForSelector !== undefined) {
              await page.waitForSelector(selector, {
                timeout: optionsResolved.waitForSelector
              })
            }
            const handle = await page.$(selector)
            elem = handle as unknown as ElementHandle<Element>
          }
          if (elem === null) {
            throw new Error(
              `Could not find element with selector "${selector}", make sure you're waiting for the elements by specifying "waitForSelector"`
            )
          }
        } else {
          elem = selector as ElementHandle<Element>
        }

        try {
          await elem.evaluate((e) => e.scrollIntoView({ block: 'center' }))
          await delay(2000)
        } catch (e) {
          log('Falling back to JS scroll method', e)
          await elem.evaluate((e) => e.scrollIntoView({ block: 'center' }))
          await delay(2000)
        }
        const box = await boundingBoxWithFallback(elem)
        const { height, width } = box
        const destination = getRandomBoxPoint(box, optionsResolved)
        const dimensions = { height, width }
        const overshooting = shouldOvershoot(previous, destination, optionsResolved.overshootThreshold ?? 500)
        const to = overshooting
          ? overshoot(destination, OVERSHOOT_RADIUS)
          : destination

        await tracePath(path(previous, to, optionsResolved))

        if (overshooting) {
          const correction = path(to, { ...dimensions, ...destination }, {
            ...optionsResolved,
            spreadOverride: OVERSHOOT_SPREAD
          })
          await tracePath(correction)
        }

        previous = destination
        actions.toggleRandomMove(true)

        const newBoundingBox = await boundingBoxWithFallback(elem)
        if (!intersectsElement(to, newBoundingBox)) {
          return await go(iteration + 1)
        }
      }
      await go(0)
      actions.toggleRandomMove(wasRandom)
      await delay((optionsResolved.moveDelay ?? 0) * ((optionsResolved.randomizeMoveDelay ?? false) ? Math.random() : 1))
    },

    async moveTo(destination: Vector, options?: MoveToOptions): Promise<void> {
      const optionsResolved: MoveToOptions = {
        moveDelay: 0,
        randomizeMoveDelay: true,
        ...defaultOptions?.moveTo,
        ...options
      }

      const wasRandom = !moving
      actions.toggleRandomMove(false)
      await tracePath(path(previous, destination, optionsResolved))
      actions.toggleRandomMove(wasRandom)
      await delay((optionsResolved.moveDelay ?? 0) * ((optionsResolved.randomizeMoveDelay ?? false) ? Math.random() : 1))
    }
  }

  if (performRandomMoves) {
    randomMove().catch(() => { })
  }

  return actions
}