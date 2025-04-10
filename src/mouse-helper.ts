import type { Page } from 'patchright-core'
import type { Page as PlaywrightPage } from 'playwright-core'

/**
 * This injects a box into the page that moves with the mouse.
 * Useful for debugging.
 */
async function installMouseHelper(page: Page | PlaywrightPage): Promise<void> {
  await page.addInitScript(() => {
    const attachListener = (): void => {
      const box = document.createElement('p-mouse-pointer')
      const styleElement = document.createElement('style')
      styleElement.innerHTML = `
        p-mouse-pointer {
          pointer-events: none;
          position: absolute;
          top: 0;
          z-index: 10000;
          left: 0;
          width: 20px;
          height: 20px;
          background: rgba(0,0,0,.4);
          border: 1px solid white;
          border-radius: 10px;
          box-sizing: border-box;
          margin: -10px 0 0 -10px;
          padding: 0;
          transition: background .2s, border-radius .2s, border-color .2s;
        }
        p-mouse-pointer.button-1 {
          transition: none;
          background: rgba(0,0,0,0.9);
        }
        p-mouse-pointer.button-2 {
          transition: none;
          border-color: rgba(0,0,255,0.9);
        }
        p-mouse-pointer.button-3 {
          transition: none;
          border-radius: 4px;
        }
        p-mouse-pointer.button-4 {
          transition: none;
          border-color: rgba(255,0,0,0.9);
        }
        p-mouse-pointer.button-5 {
          transition: none;
          border-color: rgba(0,255,0,0.9);
        }
        p-mouse-pointer-hide {
          display: none;
        }
      `
      document.head.appendChild(styleElement)
      document.body.appendChild(box)

      document.addEventListener(
        'mousemove',
        (event) => {
          box.style.left = `${event.pageX}px`
          box.style.top = `${event.pageY}px`
          box.classList.remove('p-mouse-pointer-hide')
          updateButtons(event.buttons)
        },
        true
      )
      document.addEventListener(
        'mousedown',
        (event) => {
          updateButtons(event.buttons)
          box.classList.add(`button-${event.which}`)
          box.classList.remove('p-mouse-pointer-hide')
        },
        true
      )
      document.addEventListener(
        'mouseup',
        (event) => {
          updateButtons(event.buttons)
          box.classList.remove(`button-${event.which}`)
          box.classList.remove('p-mouse-pointer-hide')
        },
        true
      )
      document.addEventListener(
        'mouseleave',
        () => {
          box.classList.add('p-mouse-pointer-hide')
        },
        true
      )
      document.addEventListener(
        'mouseenter',
        () => {
          box.classList.remove('p-mouse-pointer-hide')
        },
        true
      )

      function updateButtons(buttons: number): void {
        for (let i = 0; i < 5; i++) {
          box.classList.toggle(`button-${i}`, Boolean(buttons & (1 << i)))
        }
      }
    }

    if (document.readyState !== 'loading') {
      attachListener()
    } else {
      window.addEventListener('DOMContentLoaded', attachListener, false)
    }
  })
}

export default installMouseHelper
