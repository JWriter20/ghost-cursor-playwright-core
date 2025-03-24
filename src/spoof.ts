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

/** Get the bounding box of an element. Uses getClientRects as a first try. */
const getElementBox = async (
  page: Page | PlaywrightPage,
  element: ElementHandle<Element>,
  relativeToMainFrame: boolean = true
): Promise<BoundingBox | null> => {
  try {
    const quads = await element.evaluate((el) => {
      const rects = el.getClientRects()
      if (rects.length > 0) {
        const rect = rects[0]
        return [rect.left, rect.top, rect.right, rect.bottom]
      }
      return null
    })
    if (quads != null) {
      const elementBox: BoundingBox = {
        x: quads[0],
        y: quads[1],
        width: quads[2] - quads[0],
        height: quads[3] - quads[1]
      }
      if (!relativeToMainFrame) {
        const elementFrame = await element.contentFrame()
        if (elementFrame != null) {
          const frameElement = await elementFrame.frameElement()
          const boundingBox = await frameElement.boundingBox()
          if (boundingBox != null) {
            elementBox.x = elementBox.x - boundingBox.x
            elementBox.y = elementBox.y - boundingBox.y
          }
        }
      }
      return elementBox
    }
  } catch (_) {
    log('Could not get client rects, falling back to boundingBox')
  }
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
  page: Page | PlaywrightPage,
  elem: ElementHandle<Element>
): Promise<BoundingBox> => {
  let box = await getElementBox(page, elem)
  if (box == null) {
    box = (await elem.evaluate((el: Element) => el.getBoundingClientRect())) as BoundingBox
  }
  return box
}

export const createCursor = (
  page: Page | PlaywrightPage,
  /**
   * Cursor start position.
   * @default { x: 0, y: 0 }
   */
  start: Vector = origin,
  /**
   * Initially perform random movements.
   * If `move`, `click`, etc. is performed, these random movements end.
   * @default false
   */
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

  // Initial state: mouse is not moving
  let moving: boolean = false

  // Move the mouse over a number of vectors
  const tracePath = async (
    vectors: Iterable<Vector | TimedVector>,
    abortOnMove: boolean = false
  ): Promise<void> => {
    const cdpClient = await getCDPClient(page)

    for (const v of vectors) {
      try {
        // Abort if random movements are running and a new move is triggered
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
        // Exit function if the page is closed
        if (page.isClosed()) return

        log('Warning: could not move mouse, error message:', error)
      }
    }
  }

  // Start random mouse movements (recursive)
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

      if (selector !== undefined) {
        await actions.move(selector, {
          ...optionsResolved,
          // No moveDelay during the actual move; applied after clicking
          moveDelay: 0
        })
      }

      try {
        await delay(optionsResolved.hesitate ?? 0)
        await page.mouse.down()
        await delay(optionsResolved.waitForClick ?? 0)
        await page.mouse.up()
      } catch (error) {
        log('Warning: could not click mouse, error message:', error)
      }

      await delay((optionsResolved.moveDelay ?? 0) * ((optionsResolved.randomizeMoveDelay ?? false) ? Math.random() : 1))
      actions.toggleRandomMove(wasRandom)
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

        // Scroll element into view
        try {
          await elem.evaluate((e) => e.scrollIntoView({ block: 'center' }))
          await delay(2000)
        } catch (e) {
          log('Falling back to JS scroll method', e)
          await elem.evaluate((e) => e.scrollIntoView({ block: 'center' }))
          await delay(2000)
        }
        const box = await boundingBoxWithFallback(page, elem)
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

        const newBoundingBox = await boundingBoxWithFallback(page, elem)
        // If the element moved during the animation, try again
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

  // Start random mouse movements if requested
  if (performRandomMoves) {
    randomMove().catch(() => { })
  }

  return actions
}
