/**
 * Interactive prompt column for the report's datagrid.
 *
 * Prompt texts are long, so the column is clamped (via the datagrid's
 * native `column_size_override`, set in the default report configs)
 * and its cells are ellipsized to a single line. Clicking a prompt
 * cell expands it to its full text — wrapped within the column — and
 * clicking again collapses it back.
 *
 * The datagrid is a Perspective plugin element that renders its cells
 * inside a shadow root, so this wires a stylesheet, a click handler
 * and a mutation observer into the plugin element whenever it
 * (re)appears in the viewer: switching to a chart plugin and back
 * destroys and recreates it, while switching report tables reuses it.
 * Cell tagging re-runs after every datagrid redraw, because the grid
 * virtualizes rows and re-creates the cell elements while scrolling.
 */

/** The class tagged onto every prompt cell of the datagrid. */
const PROMPT_CELL_CLASS = 'energy-prompt-cell'

const PROMPT_CELL_CSS = `
td.${PROMPT_CELL_CLASS} {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

td.${PROMPT_CELL_CLASS}[data-expanded] {
  white-space: normal;
}
`

/** The prompt cells the user has expanded, keyed by their text. */
const expandedPrompts = new Set<string>()

/** Datagrid elements this module has already instrumented. */
const instrumented = new WeakSet<HTMLElement>()

/** Tags the prompt cells of the current datagrid redraw. */
function tagPromptCells(root: ShadowRoot): void {
  const headers = [...root.querySelectorAll('thead th')]

  const header = headers.find(th => th.textContent?.trim() === 'prompt')
  if (header === undefined || header.parentElement === null) {
    return
  }

  const index = [...header.parentElement.children].indexOf(header)
  if (index === -1) {
    return
  }

  for (const row of root.querySelectorAll('tbody tr')) {
    const cell = row.children[index]
    if (cell instanceof HTMLElement && cell.tagName === 'TD') {
      cell.classList.add(PROMPT_CELL_CLASS)

      if (
        !cell.hasAttribute('data-expanded')
        && expandedPrompts.has(cell.textContent ?? '')
      ) {
        cell.setAttribute('data-expanded', '')
      }
    }
  }
}

/** Toggles a prompt cell between expanded and collapsed. */
function togglePromptCell(cell: Element): void {
  const text = cell.textContent ?? ''
  if (cell.hasAttribute('data-expanded')) {
    cell.removeAttribute('data-expanded')
    expandedPrompts.delete(text)
  } else {
    cell.setAttribute('data-expanded', '')
    expandedPrompts.add(text)
  }
}

/** Styles and wires one datagrid plugin element. */
function instrumentDatagrid(grid: HTMLElement): void {
  if (instrumented.has(grid) || grid.shadowRoot === null) {
    return
  }

  instrumented.add(grid)

  const root = grid.shadowRoot

  const sheet = new CSSStyleSheet()
  sheet.replaceSync(PROMPT_CELL_CSS)
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]

  // clicks on shadow-internal cells compose through the plugin host
  grid.addEventListener('click', event => {
    const cell = event
      .composedPath()
      .find((target): target is Element => target instanceof Element && target.classList.contains(PROMPT_CELL_CLASS))
    if (cell !== undefined) {
      togglePromptCell(cell)
    }
  })

  // the datagrid virtualizes rows, so re-tag after every redraw
  let scheduled = false
  const observer = new MutationObserver(() => {
    if (scheduled) {
      return
    }

    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      tagPromptCells(root)
    })
  })

  observer.observe(root, { childList: true, subtree: true })

  tagPromptCells(root)
}

/**
 * Instruments every datagrid that appears inside the viewer. Returns a
 * cleanup that stops watching — the per-datagrid observers and click
 * handlers die with their elements.
 */
export function enhancePromptColumn(viewer: HTMLElement): () => void {
  const instrumentAll = () => {
    viewer.querySelectorAll('perspective-viewer-datagrid').forEach(grid => {
      instrumentDatagrid(grid as HTMLElement)
    })
  }

  // plugin switches swap the viewer's light-DOM children
  const observer = new MutationObserver(instrumentAll)
  observer.observe(viewer, { childList: true, subtree: true })
  instrumentAll()

  return () => {
    observer.disconnect()
  }
}
