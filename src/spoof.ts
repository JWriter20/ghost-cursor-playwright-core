import type { ElementHandle as CoreElementHandle, Page as CorePage, CDPSession as CoreCDPSession, Frame as CoreFrame } from 'patchright-core' // Assuming patchright-core has Frame type
import type { ElementHandle as PlaywrightElementHandle, Page as PlaywrightPage, CDPSession as PlaywrightCDPSession, Frame as PlaywrightFrame } from 'playwright-core'
import debug from 'debug'
import {
  type Vector,
  type TimedVector,
  bezierCurve,
  bezierCurveSpeed, // Note: bezierCurveSpeed is defined but not used in the current timestamp logic
  direction,
  magnitude,
  origin,
  overshoot
} from './math'
export { default as installMouseHelper } from './mouse-helper'
export { type Vector } from './math'

const log = debug('ghost-cursor')

// Combine types for easier usage
type Page = CorePage | PlaywrightPage
type Frame = CoreFrame | PlaywrightFrame
type ElementHandle<T extends Node = Node> = CoreElementHandle<T> | PlaywrightElementHandle<T>
type CDPSession = CoreCDPSession | PlaywrightCDPSession

// --- Interfaces remain the same ---

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
  // hesitate?: number; // Consider removing if not used
  readonly waitForClick?: number
}

export interface PathOptions {
  readonly spreadOverride?: number
  readonly moveSpeed?: number
  readonly useTimestamps?: boolean
}

export interface RandomMoveOptions extends Pick<MoveOptions, 'moveDelay' | 'randomizeMoveDelay' | 'moveSpeed'> { }

export interface MoveToOptions extends PathOptions, Pick<MoveOptions, 'moveDelay' | 'randomizeMoveDelay'> { }

// This is the public interface that will be returned
export interface GhostCursor {
  toggleRandomMove: (random: boolean) => void
  click: (selector?: string | ElementHandle, options?: ClickOptions) => Promise<void>
  move: (selector: string | ElementHandle, options?: MoveOptions) => Promise<void>
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
  // Avoid log2(0) or log2(negative) issues. Add a small epsilon or ensure distance/width is reasonable.
  const ratio = Math.max(distance / Math.max(width, 1), 0); // Ensure width >= 1 and ratio >= 0
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
    options.paddingPercentage >= 0 && // Allow 0 padding
    options.paddingPercentage <= 100
  ) {
    paddingWidth = (width * options.paddingPercentage) / 100
    paddingHeight = (height * options.paddingPercentage) / 100
  }

  // Ensure width/height minus padding is not negative
  const effectiveWidth = Math.max(0, width - paddingWidth);
  const effectiveHeight = Math.max(0, height - paddingHeight);

  return {
    x: x + paddingWidth / 2 + Math.random() * effectiveWidth,
    y: y + paddingHeight / 2 + Math.random() * effectiveHeight
  }
}

/** Updated helper to create a CDP session in Playwright - Always uses Page */
const getCDPClient = async (page: Page): Promise<CDPSession> => {
  // Frame doesn't have context(), need the page for CDP session
  return await page.context().newCDPSession(page as PlaywrightPage) // Cast needed if types differ significantly
}

/** Get a random point on a browser page using viewport size - Always uses Page */
export const getRandomPagePoint = async (page: Page): Promise<Vector> => {
  let viewport = page.viewportSize()
  if (viewport == null) {
    // Run evaluate on the page, not frame, to get main window dimensions
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
  // element.boundingBox() returns coordinates relative to the main frame's viewport,
  // which is what we need for CDP mouse events, regardless of the frame the element is in.
  return await element.boundingBox()
}

// --- Path generation functions ---
export function path(point: Vector, target: Vector, options?: number | PathOptions): Vector[] | TimedVector[]
export function path(point: Vector, target: BoundingBox, options?: number | PathOptions): Vector[] | TimedVector[]
export function path(start: Vector, end: BoundingBox | Vector, options?: number | PathOptions): Vector[] | TimedVector[] {
  const optionsResolved: PathOptions = typeof options === 'number'
    ? { spreadOverride: options }
    : { ...options }
  const DEFAULT_WIDTH = 100
  const MIN_STEPS = 25
  // Use end.width if it's a BoundingBox, otherwise default
  const width = typeof end === 'object' && 'width' in end && end.width !== 0 ? end.width : DEFAULT_WIDTH
  const curve = bezierCurve(start, end, optionsResolved.spreadOverride)
  const length = curve.length() * 0.8

  const speedFactor = optionsResolved.moveSpeed !== undefined && optionsResolved.moveSpeed > 0
    ? 1 / optionsResolved.moveSpeed
    : 1; // Default speed factor = 1

  const baseTime = MIN_STEPS // Base steps for minimum movement time
  const fittsID = fitts(length, width)
  // Combine base time and Fitts' law, scaled by speed
  // Adjust multiplier for Fitts' ID contribution as needed
  const steps = Math.ceil((baseTime + fittsID * 5) * speedFactor)

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
  const DEFAULT_MOVE_SPEED = 1;
  const moveSpeed = options?.moveSpeed ?? DEFAULT_MOVE_SPEED;
  const totalSteps = vectors.length;

  // Estimate total duration based on number of steps & speed.
  const avgTimePerStep = 15 / Math.max(moveSpeed, 0.1); // Avoid division by zero, ensure minimum speed effect
  const totalDuration = totalSteps * avgTimePerStep;

  const timedVectors: TimedVector[] = [];
  const startTime = Date.now();

  if (totalSteps === 0) return [];

  // Ensure division by zero is avoided for timestamp calculation with 1 step
  const divisor = totalSteps > 1 ? totalSteps - 1 : 1;

  for (let i = 0; i < totalSteps; i++) {
    const timestamp = startTime + Math.round((i / divisor) * totalDuration);
    timedVectors.push({ ...vectors[i], timestamp });
  }
  return timedVectors;
}

const shouldOvershoot = (a: Vector, b: Vector, threshold: number): boolean =>
  magnitude(direction(a, b)) > threshold

const intersectsElement = (vec: Vector, box: BoundingBox): boolean => {
  // Use non-strict inequality for boundaries to include edges
  return (
    vec.x >= box.x &&
    vec.x <= box.x + box.width &&
    vec.y >= box.y &&
    vec.y <= box.y + box.height
  )
}

const boundingBoxWithFallback = async (
  elem: ElementHandle<Element>
): Promise<BoundingBox> => {
  let box = await getElementBox(elem) // Uses element.boundingBox()
  if (box == null) {
    // Attempt scroll into view before failing
    try {
      log(`Element ${elem} has no bounding box, attempting scrollIntoViewIfNeeded.`);
      await elem.scrollIntoViewIfNeeded({ timeout: 2000 }); // Add timeout
      await delay(100); // Short delay for scroll to potentially complete
      box = await getElementBox(elem); // Try getting box again
      if (box) {
        log('Bounding box found after scrolling.');
        return box;
      }
    } catch (scrollError: unknown) {
      // Check if error is an Error instance before accessing message
      const message = scrollError instanceof Error ? scrollError.message : String(scrollError);
      log('Could not scroll element into view or find box after scroll:', message);
    }
    // If still null after trying to scroll, throw the error
    throw new Error('Element is not visible or does not have a bounding box after attempting to scroll');
  }
  return box
}

export const createCursor = (
  page: Page, // Always require the page for CDP, etc.
  start: Vector = origin,
  performRandomMovesInitially: boolean = false, // Renamed for clarity
  defaultOptions: {
    randomMove?: RandomMoveOptions
    move?: MoveOptions
    moveTo?: MoveToOptions
    click?: ClickOptions
  } = {},
  frame: Frame | null = null // Accept optional frame
): GhostCursor => {
  const OVERSHOOT_SPREAD = 10
  const OVERSHOOT_RADIUS = 120
  let previous: Vector = start
  let isMoving: boolean = false // Tracks if the cursor is actively moving *between* user actions
  let isPerformingRandomMoves: boolean = performRandomMovesInitially; // State for random moves
  let randomMoveTimeoutId: NodeJS.Timeout | null = null;

  // Determine the context for element selections: frame if provided, otherwise page
  const context: Page | Frame = frame ?? page;

  // CDP client is always associated with the page
  let cdpClientPromise: Promise<CDPSession> | null = null;
  const getOrCreateCDPClient = (): Promise<CDPSession> => {
    if (!cdpClientPromise) {
      cdpClientPromise = getCDPClient(page).catch(err => {
        log('Failed to create CDP Client', err);
        cdpClientPromise = null; // Reset promise on failure
        throw err; // Re-throw
      });
    }
    return cdpClientPromise;
  };


  const tracePath = async (
    vectors: Iterable<Vector | TimedVector>,
    abortOnMove: boolean = false // Note: This flag isn't used effectively with the current isMoving logic
  ): Promise<void> => {
    // Set isMoving true *during* the trace
    const wasMoving = isMoving; // Store state before trace
    isMoving = true;
    try {
      const cdpClient = await getOrCreateCDPClient();
      for (const v of vectors) {
        // Check page closure before each step
        if (page.isClosed()) {
          log('Page closed during tracePath, aborting.');
          isMoving = false; // Reset moving state as trace is aborted
          return;
        }

        // If abortOnMove is true, and a *new* move command resets the flag externally, we should stop.
        // However, the current logic uses isMoving to signal *this* trace is active.
        // A more robust abort might need a separate cancellation mechanism if needed.

        try {
          const dispatchParams: any = {
            type: 'mouseMoved',
            x: v.x,
            y: v.y
          }

          if ('timestamp' in v && typeof v.timestamp === 'number' && v.timestamp > 0) {
            // Convert ms to seconds for CDP
            dispatchParams.timestamp = v.timestamp / 1000;
          }

          await cdpClient.send('Input.dispatchMouseEvent', dispatchParams)
          previous = { x: v.x, y: v.y }; // Update previous position *after* successful dispatch
        } catch (error: unknown) { // Catch block for dispatchMouseEvent
          // Check if error is an Error instance before accessing message
          const isError = error instanceof Error;
          const errorMessage = isError ? error.message : String(error);

          // *** FIX: Check error type before accessing message ***
          if (page.isClosed() || (isError && (errorMessage.includes('Target closed') || errorMessage.includes('Session closed')))) {
            log('Warning: could not move mouse, page or session closed.');
            isMoving = false; // Reset moving state as trace is aborted
            return; // Stop tracing if page is closed
          }
          log('Warning: could not move mouse, error message:', errorMessage)
        }
      }
    } catch (error) { // Catch block for getOrCreateCDPClient or loop setup
      log('Error during tracePath setup or execution:', error);
    } finally {
      // Reset isMoving state *after* the trace completes or fails,
      // unless it was already false (e.g., due to page close)
      if (isMoving) {
        isMoving = false;
      }
    }
  }

  // --- Internal Helper Functions ---
  // Defined within createCursor scope, call directly without 'this' or attaching to 'actions'

  const _toggleRandomMove = (random: boolean): void => {
    if (isPerformingRandomMoves !== random) {
      isPerformingRandomMoves = random;
      if (random) {
        log('Random moves enabled');
        _scheduleRandomMove(defaultOptions?.randomMove); // Start scheduling
      } else {
        log('Random moves disabled');
        if (randomMoveTimeoutId) {
          clearTimeout(randomMoveTimeoutId); // Cancel any pending random move
          randomMoveTimeoutId = null;
        }
      }
    }
  };

  const _scheduleRandomMove = (options?: RandomMoveOptions) => {
    if (randomMoveTimeoutId) {
      clearTimeout(randomMoveTimeoutId); // Clear existing scheduled move
    }
    // Don't schedule if disabled or a user-initiated move is in progress
    if (!isPerformingRandomMoves || isMoving) {
      return;
    }

    const optionsResolved: RandomMoveOptions = {
      moveDelay: 2000, // Default delay between random moves
      randomizeMoveDelay: true,
      moveSpeed: 0.8, // Default speed for random moves
      ...defaultOptions?.randomMove,
      ...options
    };

    const delayTime = (optionsResolved.moveDelay ?? 0) * ((optionsResolved.randomizeMoveDelay ?? false) ? (0.5 + Math.random() * 0.5) : 1); // Randomize 50%-100%

    randomMoveTimeoutId = setTimeout(async () => {
      // Re-check conditions before executing
      if (!isPerformingRandomMoves || isMoving || page.isClosed()) {
        return;
      }
      try {
        const randPoint = await getRandomPagePoint(page);
        log(`Performing random move to ${JSON.stringify(randPoint)}`);
        // Use moveTo for random moves for simplicity, applying random move options
        // Need to call the public moveTo method here
        await actions.moveTo(randPoint, { // *** Call actions.moveTo ***
          moveSpeed: optionsResolved.moveSpeed,
          moveDelay: 0, // Delay is handled by the setTimeout
          randomizeMoveDelay: false // Already handled
        });
        // Schedule the *next* random move after this one completes
        // Check again if random moves are still enabled before scheduling next
        if (isPerformingRandomMoves) {
          _scheduleRandomMove(options);
        }
      } catch (error: unknown) {
        if (!page.isClosed()) {
          const message = error instanceof Error ? error.message : String(error);
          log('Warning: failed during random move, stopping random moves.', message);
          _toggleRandomMove(false); // Stop random moves on error
        }
      }
    }, delayTime);
  };


  // Helper to prepare for a user action (click, move, moveTo)
  const _startAction = async (): Promise<boolean> => {
    const wasRandomActive = isPerformingRandomMoves;
    if (wasRandomActive) {
      _toggleRandomMove(false); // Disable random moves temporarily
    }
    // Clear any pending random move timeout explicitly
    if (randomMoveTimeoutId) {
      clearTimeout(randomMoveTimeoutId);
      randomMoveTimeoutId = null;
    }
    isMoving = true; // Indicate a user-initiated cursor action is in progress
    return wasRandomActive; // Return if random moves were active before
  };

  // Helper to finish a user action
  const _endAction = async (
    wasRandomActive: boolean,
    moveDelayOptions: { moveDelay?: number, randomizeMoveDelay?: boolean }
  ): Promise<void> => {
    isMoving = false; // User action finished

    // Apply post-action delay
    const delayTime = (moveDelayOptions.moveDelay ?? 0) * ((moveDelayOptions.randomizeMoveDelay ?? false) ? Math.random() : 1);
    await delay(delayTime);

    // Only re-enable random moves if they were on *before* this action started
    // and no other action has started in the meantime (isMoving is false)
    if (wasRandomActive && !isMoving) {
      _toggleRandomMove(true);
    }
  };


  // --- Public GhostCursor methods ---
  // This is the object that will be returned. It implements the GhostCursor interface.
  const actions: GhostCursor = {
    // Use the internal toggle function
    toggleRandomMove: _toggleRandomMove,

    getLocation(): Vector {
      return previous
    },

    async click(
      selector?: string | ElementHandle,
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
        ...defaultOptions?.move,
        ...defaultOptions?.click,
        ...options
      };

      // *** FIX: Call helper function directly ***
      const wasRandom = await _startAction();

      try {
        let targetElement: ElementHandle<HTMLElement> | null = null;
        let targetPoint: Vector = previous;

        if (selector) {
          log(`Clicking element: ${typeof selector === 'string' ? selector : 'ElementHandle'}`);
          // Move to the element first using the public 'move' method
          await actions.move(selector, { // *** Call actions.move ***
            waitForSelector: optionsResolved.waitForSelector,
            paddingPercentage: optionsResolved.paddingPercentage,
            moveSpeed: optionsResolved.moveSpeed,
            maxTries: optionsResolved.maxTries,
            overshootThreshold: optionsResolved.overshootThreshold,
            moveDelay: 0, // No delay during the move part of the click
            randomizeMoveDelay: false
          });
          targetPoint = previous; // Update target point to where move ended

          // Re-resolve element handle after move
          if (typeof selector === 'string') {
            // Use context (page or frame) to find the element
            targetElement = await context.$(selector) as ElementHandle<HTMLElement> | null;
          } else {
            // Re-check the provided handle
            targetElement = selector as ElementHandle<HTMLElement>;
            if (!targetElement || !(await targetElement.isVisible())) { // Basic check
              throw new Error('Provided ElementHandle is not valid or visible after move.');
            }
          }

          if (!targetElement) {
            throw new Error(`Element ${selector} not found or became invalid after moving to it.`);
          }

          const boundingBox = await boundingBoxWithFallback(targetElement);
          const offset = {
            x: targetPoint.x - boundingBox.x,
            y: targetPoint.y - boundingBox.y
          };

          // Clamp offset to be within the bounding box to avoid errors
          const clampedOffset = {
            x: Math.max(0, Math.min(offset.x, boundingBox.width)),
            y: Math.max(0, Math.min(offset.y, boundingBox.height))
          };


          log(`Performing click on element at offset ${JSON.stringify(clampedOffset)} (original: ${JSON.stringify(offset)})`);
          // Use Playwright's built-in click
          await targetElement.click({
            position: clampedOffset,
            delay: optionsResolved.waitForClick ?? 0,
            force: true, // Consider if force is always needed
            timeout: 5000
          });

        } else {
          // Click at the current location
          log(`Performing click at current location: ${JSON.stringify(previous)}`);
          await page.mouse.click(previous.x, previous.y, {
            delay: optionsResolved.waitForClick ?? 0
          });
        }

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log('Error: could not perform click, error message:', errorMessage);
        // Optional: throw error to signal failure to the caller
        // throw new Error(`Failed to click ${selector ? selector.toString() : 'current location'}. Error: ${errorMessage}`);
      } finally {
        // *** FIX: Call helper function directly ***
        await _endAction(wasRandom, optionsResolved);
      }
    },

    async move(
      selector: string | ElementHandle,
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
      };

      // *** FIX: Call helper function directly ***
      const wasRandom = await _startAction();
      let success = false; // Track if move succeeded
      let lastError: Error | null = null;

      try {
        const go = async (iteration: number): Promise<boolean> => {
          if (page.isClosed()) {
            log('Page closed during move, aborting.');
            return false;
          }
          if (iteration >= (optionsResolved.maxTries ?? 3)) {
            log(`Could not move to element within ${optionsResolved.maxTries} tries.`);
            lastError = new Error(`Could not mouse-over element within ${optionsResolved.maxTries} tries`);
            return false;
          }

          log(`Move attempt ${iteration + 1} for selector: ${typeof selector === 'string' ? selector : 'ElementHandle'}`);

          let elem: ElementHandle<Element> | null = null;
          try {
            // Find element using the correct context (page or frame)
            if (typeof selector === 'string') {
              elem = await context.waitForSelector(selector, {
                state: 'visible',
                timeout: optionsResolved.waitForSelector
              }) as ElementHandle<Element>;
            } else {
              elem = selector as ElementHandle<Element>;
              if (!(await elem.isVisible())) { // Check visibility for handles too
                throw new Error('Provided ElementHandle is not visible');
              }
            }

            // Element found, proceed with move logic
            await elem.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(scrollError => {
              log('Warning: could not scroll element into view:', scrollError);
            });
            await delay(100);

            const box = await boundingBoxWithFallback(elem);
            const { height, width } = box;
            const destination = getRandomBoxPoint(box, { paddingPercentage: optionsResolved.paddingPercentage });
            const dimensions = { height, width };

            log(`Target element box: ${JSON.stringify(box)}, moving to point: ${JSON.stringify(destination)}`);

            const overshooting = shouldOvershoot(previous, destination, optionsResolved.overshootThreshold ?? 500);
            const targetPoint = overshooting ? overshoot(destination, OVERSHOOT_RADIUS) : destination;

            await tracePath(path(previous, targetPoint, optionsResolved), false);

            if (overshooting) {
              log('Overshooting, correcting path...');
              const correction = path(targetPoint, { ...dimensions, ...destination }, {
                spreadOverride: OVERSHOOT_SPREAD,
                moveSpeed: optionsResolved.moveSpeed
              });
              await tracePath(correction, false);
            }

            // Verify final position
            const finalPos = previous;
            const finalBox = await getElementBox(elem); // Get box again

            if (finalBox && intersectsElement(finalPos, finalBox)) {
              log(`Successfully moved over element: ${typeof selector === 'string' ? selector : 'ElementHandle'}`);
              return true; // Success
            } else {
              log(`Move completed, but cursor at ${JSON.stringify(finalPos)} is not over the element's final box: ${JSON.stringify(finalBox)}. Retrying...`);
              lastError = new Error(`Cursor position ${JSON.stringify(finalPos)} does not intersect element box ${JSON.stringify(finalBox)}`);
              return await go(iteration + 1); // Retry
            }

          } catch (error: unknown) { // Catch errors during find/move attempt
            lastError = error instanceof Error ? error : new Error(String(error));
            log(`Error during move attempt ${iteration + 1}:`, lastError.message);
            await delay(200 + Math.random() * 300); // Wait before retrying
            return await go(iteration + 1); // Retry
          }
        } // end go function

        success = await go(0); // Start the retry loop

      } catch (error) { // Catch unexpected errors outside the retry loop
        log(`Unexpected error during move setup: ${error}`);
        lastError = error instanceof Error ? error : new Error(String(error));
        success = false;
      } finally {
        await _endAction(wasRandom, optionsResolved);
        if (!success) {
          log(`Move action failed for selector: ${typeof selector === 'string' ? selector : 'ElementHandle'}`);
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
      };

      // *** FIX: Call helper function directly ***
      const wasRandom = await _startAction();

      try {
        log(`Moving to absolute position: ${JSON.stringify(destination)}`);
        await tracePath(path(previous, destination, optionsResolved), false);
      } catch (error) {
        log('Error during moveTo:', error);
      } finally {
        await _endAction(wasRandom, optionsResolved);
      }
    }
  }; // End of actions object definition

  // Initialize random moves if requested
  if (isPerformingRandomMoves) {
    // Use the internal function to start scheduling
    _scheduleRandomMove(defaultOptions?.randomMove);
  }

  return actions; // Return the public interface
}