/**
 * The answer readers: duck-typed extraction of one finalized assistant message
 * out of the two snapshots a session-scoped slot can reach.
 *
 * The shapes below are the DSH 0.1.5-rc.2 ones (chat `assistant-step` nodes with
 * `data.finalNode.messageId`, trajectory `assistant` event nodes); every "wrong
 * shape" case is pinned too, because a version skew must hide the action rather
 * than throw inside the message row.
 */
import { describe, expect, it } from 'vitest'
import {
  ANSWER_BLOCK_SEPARATOR,
  answerTextFromBlocks,
  answerTextFromChat,
  answerTextFromTrajectory,
  answerTitle,
} from '../src/client/answerAction'

/** The chat snapshot shape: `nodes.values()` of view nodes. */
function chatSnapshot(entries: unknown[]): unknown {
  return { nodes: { values: () => entries } }
}

function assistantStep(messageId: string, blocks: unknown[]): unknown {
  return { kind: 'assistant-step', data: { status: 'settled', finalNode: { messageId }, blocks } }
}

describe('answerTextFromBlocks', () => {
  it('joins the text blocks in order', () => {
    const blocks = [
      { kind: 'text', text: '第一段' },
      { kind: 'tool-call', callId: 'c1', name: 'read', argsRaw: '{}' },
      { kind: 'text', text: '第二段' },
    ]
    expect(answerTextFromBlocks(blocks)).toBe(`第一段${ANSWER_BLOCK_SEPARATOR}第二段`)
  })

  it('leaves reasoning, images and unknown blocks out of the answer', () => {
    const blocks = [
      { kind: 'reasoning', text: 'private deliberation' },
      { kind: 'text', text: 'the answer' },
      { kind: 'image', attachment: { id: 'a1' } },
      { kind: 'other', block: { anything: true } },
    ]
    expect(answerTextFromBlocks(blocks)).toBe('the answer')
  })

  it('drops empty text blocks instead of emitting blank paragraphs', () => {
    expect(answerTextFromBlocks([{ kind: 'text', text: '' }, { kind: 'text', text: 'x' }])).toBe('x')
  })

  it('reports null when there is no prose at all', () => {
    expect(answerTextFromBlocks([{ kind: 'tool-call', callId: 'c', name: 'x', argsRaw: '{}' }])).toBeNull()
    expect(answerTextFromBlocks([])).toBeNull()
    expect(answerTextFromBlocks(undefined)).toBeNull()
    expect(answerTextFromBlocks('not an array')).toBeNull()
  })
})

describe('answerTextFromChat', () => {
  it('finds the answer of the requested message', () => {
    const snapshot = chatSnapshot([
      { kind: 'user' },
      assistantStep('m1', [{ kind: 'text', text: 'first answer' }]),
      assistantStep('m2', [{ kind: 'text', text: 'second answer' }]),
    ])
    expect(answerTextFromChat(snapshot, 'm2')).toBe('second answer')
  })

  it('returns null for a message the snapshot does not hold', () => {
    const snapshot = chatSnapshot([assistantStep('m1', [{ kind: 'text', text: 'a' }])])
    expect(answerTextFromChat(snapshot, 'missing')).toBeNull()
  })

  it('returns null for an answer with no prose', () => {
    const snapshot = chatSnapshot([assistantStep('m1', [{ kind: 'tool-call', callId: 'c', name: 'x', argsRaw: '{}' }])])
    expect(answerTextFromChat(snapshot, 'm1')).toBeNull()
  })

  it('ignores non-assistant-step nodes and their stale ids', () => {
    const snapshot = chatSnapshot([
      { kind: 'tool-call', data: { finalNode: { messageId: 'm1' }, blocks: [{ kind: 'text', text: 'tool' }] } },
      assistantStep('m1', [{ kind: 'text', text: 'the answer' }]),
    ])
    expect(answerTextFromChat(snapshot, 'm1')).toBe('the answer')
  })

  it('accepts a messageId carried on the node data itself', () => {
    const snapshot = chatSnapshot([{ kind: 'assistant-step', data: { messageId: 'm9', blocks: [{ kind: 'text', text: 'x' }] } }])
    expect(answerTextFromChat(snapshot, 'm9')).toBe('x')
  })

  it('reports "not a chat snapshot" (undefined) for a foreign shape', () => {
    expect(answerTextFromChat(undefined, 'm')).toBeUndefined()
    expect(answerTextFromChat({}, 'm')).toBeUndefined()
    expect(answerTextFromChat({ nodes: {} }, 'm')).toBeUndefined()
    expect(answerTextFromChat({ nodes: { values: () => 'nope' } }, 'm')).toBeUndefined()
  })

  it('reports "not a chat snapshot" when values() throws', () => {
    const snapshot = {
      nodes: {
        values: () => {
          throw new Error('detached store')
        },
      },
    }
    expect(answerTextFromChat(snapshot, 'm')).toBeUndefined()
  })

  /**
   * An interrupted answer is assembled from chunks and carries NO
   * `finalNode.messageId`. A loose comparison would match it against an empty
   * requested id and file that unrelated reply under the session's title.
   */
  it('never matches an id-less interrupted answer', () => {
    const interrupted = chatSnapshot([{ kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'STALE' }] } }])
    expect(answerTextFromChat(interrupted, '')).toBeNull()
    expect(answerTextFromChat(interrupted, 'm1')).toBeNull()
  })
})

describe('answerTextFromTrajectory', () => {
  it('finds the assistant event node by message id', () => {
    const snapshot = {
      eventNodes: [
        { kind: 'user', seq: 1 },
        { kind: 'assistant', seq: 2, messageId: 'm1', blocks: [{ kind: 'text', text: 'answer' }] },
      ],
    }
    expect(answerTextFromTrajectory(snapshot, 'm1')).toBe('answer')
  })

  it('returns null when the message is absent, or has no prose', () => {
    const snapshot = { eventNodes: [{ kind: 'assistant', seq: 2, messageId: 'm2', blocks: [] }] }
    expect(answerTextFromTrajectory(snapshot, 'm1')).toBeNull()
    expect(answerTextFromTrajectory(snapshot, 'm2')).toBeNull()
  })

  it('reports "not a trajectory snapshot" (undefined) for a foreign shape', () => {
    expect(answerTextFromTrajectory(undefined, 'm')).toBeUndefined()
    expect(answerTextFromTrajectory({}, 'm')).toBeUndefined()
    expect(answerTextFromTrajectory({ eventNodes: 'nope' }, 'm')).toBeUndefined()
  })

  it('never matches an id-less event node', () => {
    const snapshot = { eventNodes: [{ kind: 'assistant', blocks: [{ kind: 'text', text: 'STALE' }] }] }
    expect(answerTextFromTrajectory(snapshot, '')).toBeNull()
    expect(answerTextFromTrajectory(snapshot, 'm1')).toBeNull()
  })
})

describe('answerTitle', () => {
  it('uses the session title trimmed', () => {
    expect(answerTitle('  重构计划  ')).toBe('重构计划')
  })

  it('returns "" for a session with no title yet, or a non-string', () => {
    expect(answerTitle(null)).toBe('')
    expect(answerTitle(undefined)).toBe('')
    expect(answerTitle('   ')).toBe('')
    expect(answerTitle(42)).toBe('')
  })
})
