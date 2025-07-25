import type { Page } from 'patchright-core'
import { type ClickOptions, createCursor, GhostCursor } from '../spoof'
import { join } from 'path'
import { promises as fs } from 'fs'
import installMouseHelper from '../mouse-helper'

declare const page: Page

let cursor: GhostCursor

const cursorDefaultOptions = {
  moveDelay: 0,
  moveSpeed: 99,
  waitForClick: 0
} as const satisfies ClickOptions

describe('Mouse movements', () => {
  beforeAll(async () => {
    await installMouseHelper(page)
    const html = await fs.readFile(join(__dirname, 'custom-page.html'), 'utf8')
    await page.goto('data:text/html,' + encodeURIComponent(html), { waitUntil: 'networkidle' })
  })

  beforeEach(async () => {
    cursor = createCursor(page, undefined, undefined, {
      move: cursorDefaultOptions,
      click: cursorDefaultOptions,
      moveTo: cursorDefaultOptions
    })
    // Reset click counters before each test
    await page.evaluate(() => {
      (window as any).resetClickCounters?.()
    })
  })

  // Helper function to safely get click count
  const getClickCount = async (counterId: string): Promise<number> => {
    return await page.evaluate((id) => {
      const counter = document.getElementById(id)
      if (counter?.textContent != null) {
        const text = counter.textContent.trim()
        const count = parseInt(text, 10)
        return isNaN(count) ? 0 : count
      }
      return 0
    }, counterId)
  }

  it('Should click on the element without throwing an error (CSS selector)', async () => {
    await cursor.click('#box')
    const clickCount = await getClickCount('box-counter')
    expect(clickCount).toBe(1)
  })

  it('Should click on the element without throwing an error (XPath selector)', async () => {
    await cursor.click('//*[@id="box"]')
    const clickCount = await getClickCount('box-counter')
    expect(clickCount).toBe(1)
  })

  describe('Adjacent elements precision', () => {
    it('Should click the correct element when two elements are adjacent (left box)', async () => {
      // Click left box multiple times to ensure precision
      await cursor.click('#left-box')
      await cursor.click('#left-box')
      await cursor.click('#left-box')

      const clickCounts = {
        left: await getClickCount('left-counter'),
        right: await getClickCount('right-counter')
      }

      expect(clickCounts.left).toBe(3)
      expect(clickCounts.right).toBe(0)
    })

    it('Should click the correct element when two elements are adjacent (right box)', async () => {
      await cursor.click('#right-box')
      await cursor.click('#right-box')

      const clickCounts = {
        left: await getClickCount('left-counter'),
        right: await getClickCount('right-counter')
      }

      expect(clickCounts.left).toBe(0)
      expect(clickCounts.right).toBe(2)
    })

    it('Should alternate between adjacent elements correctly', async () => {
      await cursor.click('#left-box')
      await cursor.click('#right-box')
      await cursor.click('#left-box')
      await cursor.click('#right-box')

      const clickCounts = {
        left: await getClickCount('left-counter'),
        right: await getClickCount('right-counter')
      }

      expect(clickCounts.left).toBe(2)
      expect(clickCounts.right).toBe(2)
    })
  })

  describe('Moving element reliability', () => {
    it('Should handle element that moves during click operation', async () => {
      // Start moving to the element
      const movePromise = cursor.move('#moving-box')

      // Trigger movement of the box during the move operation
      await page.evaluate(() => {
        setTimeout(() => {
          (window as any).triggerMovingBoxMove?.()
        }, 50)
      })

      await movePromise

      // Now click - the element might have moved, but locator should handle it
      await cursor.click('#moving-box')

      const clickCount = await getClickCount('moving-counter')

      expect(clickCount).toBe(1)
    })

    it('Should handle rapid clicks on a moving element', async () => {
      // Multiple rapid clicks while element is moving - perform sequentially
      for (let i = 0; i < 3; i++) {
        // Trigger movement before each click
        await page.evaluate(() => {
          (window as any).triggerMovingBoxMove?.()
        })

        // Wait a bit for movement to start
        await page.waitForTimeout(100)

        // Perform the click
        await cursor.click('#moving-box')

        // Small delay between clicks
        await page.waitForTimeout(100)
      }

      const clickCount = await getClickCount('moving-counter')

      expect(clickCount).toBe(3)
    })
  })

  describe('Small element precision', () => {
    it('Should successfully click on small elements', async () => {
      await cursor.click('#small-box')
      await cursor.click('#small-box')

      const clickCount = await getClickCount('small-counter')

      expect(clickCount).toBe(2)
    })

    it('Should click small elements with different padding percentages', async () => {
      // Test with minimal padding
      await cursor.click('#small-box', { paddingPercentage: 5 })

      // Test with no padding
      await cursor.click('#small-box', { paddingPercentage: 0 })

      const clickCount = await getClickCount('small-counter')

      expect(clickCount).toBe(2)
    })
  })

  describe('Error handling and edge cases', () => {
    it('Should handle clicking on non-existent elements gracefully', async () => {
      await expect(cursor.click('#non-existent', { waitForSelector: 1000 })).rejects.toThrow()
    })

    it('Should handle clicking with invalid selectors gracefully', async () => {
      await expect(cursor.click('invalid-selector', { waitForSelector: 1000 })).rejects.toThrow()
    })

    it('Should handle XPath selectors for adjacent elements', async () => {
      await cursor.click('//*[@id="left-box"]')
      await cursor.click('//*[@id="right-box"]')

      const clickCounts = {
        left: await getClickCount('left-counter'),
        right: await getClickCount('right-counter')
      }

      expect(clickCounts.left).toBe(1)
      expect(clickCounts.right).toBe(1)
    })
  })

  describe('Click without selector', () => {
    it('Should click at current cursor position when no selector provided', async () => {
      // Move to a specific position first
      await cursor.moveTo({ x: 400, y: 300 })

      // Click at current position
      await cursor.click()

      // Verify the cursor is still at the same position
      const location = cursor.getLocation()
      expect(location.x).toBe(400)
      expect(location.y).toBe(300)
    })
  })

  describe('Reliability stress tests', () => {
    it('Should handle multiple rapid clicks on different elements', async () => {
      const elements = ['#box', '#left-box', '#right-box', '#small-box']

      // Perform clicks sequentially to ensure proper counting
      for (let i = 0; i < 4; i++) {
        for (const element of elements) {
          await cursor.click(element)
        }
      }

      // Verify all elements were clicked
      const allClickCounts = await Promise.all([
        getClickCount('box-counter'),
        getClickCount('left-counter'),
        getClickCount('right-counter'),
        getClickCount('small-counter')
      ])

      allClickCounts.forEach(count => {
        expect(count).toBe(4)
      })
    })

    it('Should handle concurrent clicks on the same element', async () => {
      // Test that the enhanced click function can handle concurrent clicks
      const clickPromises: Array<Promise<void>> = []

      for (let i = 0; i < 3; i++) {
        clickPromises.push(cursor.click('#box'))
      }

      await Promise.all(clickPromises)

      // Verify at least some clicks were successful
      const clickCount = await getClickCount('box-counter')

      expect(clickCount).toBeGreaterThanOrEqual(1)
      expect(clickCount).toBeLessThanOrEqual(3)
    })
  })
})

jest.setTimeout(30_000)
