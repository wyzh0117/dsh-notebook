/**
 * Answer-to-notebook (v0.2.0): reading one finalized assistant message out of
 * the client's own snapshots.
 *
 * Everything here is **duck-typed on purpose**, for the same reason
 * `composer.ts` is: the client half is a CJS closure factory whose `require`
 * resolves only the shell's module table, so the DSH UI packages cannot be
 * imported (their types and their values are both out of reach), and their
 * snapshot shapes differ between DSH versions. The two readers below therefore
 * walk an `unknown` snapshot and return `null` the moment the shape is not what
 * they expect — a composition that renamed a field keeps a working plugin that
 * simply hides the action instead of throwing inside the message row.
 *
 * The shapes they accept, verified against DSH 0.1.5-rc.2:
 *
 * - **chat** (`useChat`): `ChatSnapshot.nodes.values()` yields nodes whose
 *   `kind` is `'assistant-step'`; such a node's `data.finalNode` is the
 *   finalized assistant message, and `data.blocks` holds its content blocks.
 * - **trajectory** (`useTrajectory`): `eventNodes` is a flat list of
 *   conversation nodes, the assistant ones carrying `kind: 'assistant'`,
 *   `messageId` and `blocks`.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */

/** Block kinds whose text belongs to the answer the user sees. */
const ANSWER_BLOCK_KIND = 'text'

/** How answer blocks are joined: a blank line, so markdown paragraphs survive. */
export const ANSWER_BLOCK_SEPARATOR = '\n\n'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The answer text of a block list: every `text` block, in order, joined by a
 * blank line.
 *
 * Deliberately ONLY `text` blocks. `reasoning` blocks are the model's private
 * deliberation, `tool-call` blocks are not prose, and `image` / `other` blocks
 * carry no text a note could hold — the user's "the answer" is the prose the
 * transcript renders as the reply.
 *
 * @returns the joined text, or `null` when there is no prose at all (an answer
 *   that is nothing but tool calls has nothing to save).
 */
export function answerTextFromBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.kind !== ANSWER_BLOCK_KIND) continue
    const text = asString(block.text)
    if (text.length === 0) continue
    parts.push(text)
  }
  if (parts.length === 0) return null
  return parts.join(ANSWER_BLOCK_SEPARATOR)
}

/** The message id a chat node carries, if any (the finalized message's id). */
function chatNodeMessageId(data: unknown): string {
  if (!isRecord(data)) return ''
  const final = data.finalNode
  if (isRecord(final)) {
    const id = asString(final.messageId)
    if (id.length > 0) return id
  }
  return asString(data.messageId)
}

/**
 * Read the answer of `messageId` out of a chat snapshot.
 *
 * @returns the answer text; `null` when the snapshot IS a chat snapshot but does
 *   not hold this message (or the message holds no prose); `undefined` when the
 *   snapshot is not shaped like a chat snapshot at all — the caller hides the
 *   action for `undefined` and keeps an honest "nothing to save" for `null`.
 */
export function answerTextFromChat(snapshot: unknown, messageId: string): string | null | undefined {
  if (!isRecord(snapshot)) return undefined
  // An empty id can never be matched safely: an interrupted answer carries no
  // `finalNode.messageId`, so `'' === ''` would file an unrelated reply.
  if (messageId.length === 0) return null
  const nodes = snapshot.nodes
  if (!isRecord(nodes) || typeof nodes.values !== 'function') return undefined
  let values: unknown
  try {
    values = (nodes.values as () => unknown).call(nodes)
  } catch {
    return undefined
  }
  if (!Array.isArray(values)) return undefined

  for (const node of values) {
    if (!isRecord(node)) continue
    if (node.kind !== 'assistant-step') continue
    if (chatNodeMessageId(node.data) !== messageId) continue
    return answerTextFromBlocks(isRecord(node.data) ? node.data.blocks : undefined)
  }
  return null
}

/**
 * Read the answer of `messageId` out of a trajectory snapshot (the fallback
 * reader for a composition whose chat view is not the active target).
 *
 * @returns the answer text; `null` when the snapshot IS a trajectory snapshot
 *   but does not hold this message (or holds no prose); `undefined` when the
 *   snapshot is not a trajectory snapshot at all.
 */
export function answerTextFromTrajectory(snapshot: unknown, messageId: string): string | null | undefined {
  if (!isRecord(snapshot)) return undefined
  if (messageId.length === 0) return null
  const nodes = snapshot.eventNodes
  if (!Array.isArray(nodes)) return undefined

  for (const node of nodes) {
    if (!isRecord(node)) continue
    if (node.kind !== 'assistant') continue
    if (asString(node.messageId) !== messageId) continue
    return answerTextFromBlocks(node.blocks)
  }
  return null
}

/**
 * The note title for an answer: the session's own title.
 *
 * @returns the trimmed title, or `''` when the session has none yet — the
 *   caller then lets the capture mint the numbered default rather than filing
 *   the note under a placeholder the user never chose.
 */
export function answerTitle(sessionTitle: unknown): string {
  return asString(sessionTitle).trim()
}
