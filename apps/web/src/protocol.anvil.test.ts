// @vitest-environment node
/// <reference types="node" />
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { synchronizeDirectMessageStream } from './direct-message-stream'
import { synchronizeGroupDirectory } from './group-directory'
import { synchronizeGroupMembershipStream } from './group-membership-stream'
import { synchronizeGroupMessageStream } from './group-message-stream'
import {
  parseAccounts,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import { synchronizePostFeed } from './post-feed'
import { waitForPostFeedConfirmation } from './post-feed-confirmation'
import { openPostCommentProjectionRun } from './post-comment-projection-run'
import { synchronizePostCommentStream } from './post-comment-stream'
import { PostReactionProjection } from './post-reaction-projection'
import { openPostReactionProjectionRun } from './post-reaction-projection-run'
import { synchronizePostReactionStream } from './post-reaction-stream'
import { parseMediaCid } from './media-cid'
import {
  createGroup,
  deployProtocol,
  inspectProtocol,
  LOCAL_CHAIN_ID,
  publishComment,
  publishRepost,
  publishPost,
  sendDirectMessage,
  sendGroupMessage,
  setGroupMembership,
  setProfile,
  setPostLike,
} from './protocol'
const MEDIA_CID = parseMediaCid(
  'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C',
)!
type JsonRpcResponse = {
  error?: { code?: number; message?: string }
  result?: unknown
}
let anvil: ChildProcess | undefined
let provider: Eip1193Provider
let stderr = ''
async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local TCP port.'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}
function makeHttpProvider(url: string): Eip1193Provider {
  let requestId = 0
  return {
    async request({ method, params }: ProviderRequest) {
      const response = await fetch(url, {
        body: JSON.stringify({
          id: ++requestId,
          jsonrpc: '2.0',
          method,
          params: params ?? [],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok)
        throw new Error(`Local RPC returned HTTP ${response.status}.`)
      const payload = (await response.json()) as JsonRpcResponse
      if (payload.error) {
        const error = new Error(
          payload.error.message ?? 'Local RPC request failed.',
        )
        Object.assign(error, { code: payload.error.code })
        throw error
      }
      return payload.result
    },
  }
}
async function waitForAnvil() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (anvil?.exitCode !== null) {
      throw new Error(`Anvil exited during startup. ${stderr}`)
    }
    try {
      if ((await provider.request({ method: 'eth_chainId' })) === '0x7a69')
        return
    } catch {
      // Anvil has not bound its loopback socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Anvil did not become ready. ${stderr}`)
}
beforeAll(async () => {
  const port = await reservePort()
  provider = makeHttpProvider(`http://127.0.0.1:${port}`)
  anvil = spawn(
    'anvil',
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  anvil.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2_000)
  })
  await waitForAnvil()
}, 10_000)
afterAll(async () => {
  if (!anvil || anvil.exitCode !== null) return
  await new Promise<void>((resolve) => {
    anvil?.once('exit', () => resolve())
    anvil?.kill('SIGTERM')
    setTimeout(resolve, 2_000)
  })
})
describe('wallet transaction helpers on Anvil', () => {
  it('deploys v1 and verifies profile, post, reaction, direct-message, and group transactions', async () => {
    const accounts = parseAccounts(
      await provider.request({ method: 'eth_accounts' }),
    )
    const account = accounts[0]
    const recipient = accounts[1]
    expect(account).toBeDefined()
    expect(recipient).toBeDefined()
    if (!account || !recipient) return
    await expect(inspectProtocol(provider)).resolves.toEqual({
      kind: 'deployable',
    })
    await expect(
      deployProtocol(provider, account, LOCAL_CHAIN_ID, undefined, provider),
    ).resolves.toMatchObject({ blockNumber: 1n })
    await expect(inspectProtocol(provider)).resolves.toEqual({ kind: 'ready' })
    await expect(
      setProfile(
        provider,
        account,
        LOCAL_CHAIN_ID,
        {
          avatarCid: MEDIA_CID.bytes,
          bio: 'Every detail is on-chain.',
          displayName: 'Tracey',
        },
        undefined,
        provider,
      ),
    ).resolves.toMatchObject({ blockNumber: 2n })
    const postReceipt = await publishPost(
      provider,
      account,
      LOCAL_CHAIN_ID,
      { body: '', mediaCid: MEDIA_CID.bytes },
      undefined,
      provider,
    )
    expect(postReceipt).toMatchObject({ blockNumber: 3n })
    await expect(
      publishComment(
        provider,
        account,
        LOCAL_CHAIN_ID,
        1n,
        { body: 'Nothing here is private.', mediaCid: '0x' },
        undefined,
        provider,
      ),
    ).resolves.toMatchObject({ blockNumber: 4n })
    await expect(
      setPostLike(
        provider,
        account,
        LOCAL_CHAIN_ID,
        1n,
        true,
        undefined,
        provider,
      ),
    ).resolves.toMatchObject({ blockNumber: 5n })
    await expect(
      setPostLike(
        provider,
        account,
        LOCAL_CHAIN_ID,
        1n,
        false,
        undefined,
        provider,
      ),
    ).resolves.toMatchObject({ blockNumber: 6n })
    await expect(
      publishRepost(provider, account, LOCAL_CHAIN_ID, 1n, undefined, provider),
    ).resolves.toMatchObject({ blockNumber: 7n })
    const directMessageReceipt = await sendDirectMessage(
      provider,
      account,
      LOCAL_CHAIN_ID,
      recipient,
      { body: 'This message is permanently public.', mediaCid: '0x' },
      undefined,
      provider,
    )
    expect(directMessageReceipt).toMatchObject({
      blockNumber: 8n,
      messageId: 1n,
    })
    const groupReceipt = await createGroup(
      provider,
      account,
      LOCAL_CHAIN_ID,
      { metadataCid: MEDIA_CID.bytes, name: 'Bagholders Anonymous' },
      undefined,
      provider,
    )
    expect(groupReceipt).toMatchObject({ blockNumber: 9n, groupId: 1n })
    await expect(
      setGroupMembership(
        provider,
        account,
        LOCAL_CHAIN_ID,
        groupReceipt.groupId,
        true,
        undefined,
        provider,
      ),
    ).resolves.toMatchObject({ blockNumber: 10n })
    const groupMessageReceipt = await sendGroupMessage(
      provider,
      account,
      LOCAL_CHAIN_ID,
      groupReceipt.groupId,
      {
        body: 'Membership does not make this private.',
        mediaCid: MEDIA_CID.bytes,
      },
      undefined,
      provider,
    )
    expect(groupMessageReceipt).toMatchObject({
      blockNumber: 11n,
      messageId: 2n,
    })
    await expect(
      setProfile(
        provider,
        account,
        LOCAL_CHAIN_ID,
        { avatarCid: '0x', bio: '', displayName: '' },
        undefined,
        provider,
      ),
    ).resolves.toMatchObject({ blockNumber: 12n })
    const confirmation = waitForPostFeedConfirmation(
      provider,
      LOCAL_CHAIN_ID,
      {
        ...postReceipt,
        expectedPost: {
          author: account,
          body: '',
          mediaCid: MEDIA_CID.bytes,
        },
      },
      { pollIntervalMs: 1, timeoutMs: 2_000 },
    )
    await provider.request({ method: 'anvil_mine', params: ['0xc'] })
    await confirmation
    const publicConversation = await synchronizeDirectMessageStream(
      provider,
      LOCAL_CHAIN_ID,
      account,
      recipient,
      {
        storage: {
          databaseName: 'lifeinvader-anvil-direct-messages',
          factory: new IDBFactory(),
          keyRange: IDBKeyRange,
        },
      },
    )
    expect(publicConversation).toMatchObject({
      caughtUp: true,
      recentMessages: [
        {
          body: 'This message is permanently public.',
          mediaCid: '0x',
          messageId: 1n,
          recipient,
          sender: account,
        },
      ],
    })
    const groupDirectory = await synchronizeGroupDirectory(
      provider,
      LOCAL_CHAIN_ID,
      {
        storage: {
          databaseName: 'lifeinvader-anvil-group-directory',
          factory: new IDBFactory(),
          keyRange: IDBKeyRange,
        },
      },
    )
    expect(groupDirectory).toMatchObject({
      caughtUp: true,
      groups: [
        {
          creator: account,
          groupId: groupReceipt.groupId,
          metadataCid: MEDIA_CID.bytes,
          name: 'Bagholders Anonymous',
        },
      ],
    })
    const publicMembership = await synchronizeGroupMembershipStream(
      provider,
      LOCAL_CHAIN_ID,
      groupReceipt.groupId,
      {
        storage: {
          databaseName: 'lifeinvader-anvil-group-memberships',
          factory: new IDBFactory(),
          keyRange: IDBKeyRange,
        },
      },
    )
    expect(publicMembership).toMatchObject({
      caughtUp: true,
      groupId: groupReceipt.groupId,
      recentSignals: [
        {
          account,
          groupId: groupReceipt.groupId,
          joined: true,
        },
      ],
    })
    expect(publicMembership.projectionAnchor).toBeDefined()
    const publicGroup = await synchronizeGroupMessageStream(
      provider,
      LOCAL_CHAIN_ID,
      groupReceipt.groupId,
      {
        storage: {
          databaseName: 'lifeinvader-anvil-group-messages',
          factory: new IDBFactory(),
          keyRange: IDBKeyRange,
        },
      },
    )
    expect(publicGroup).toMatchObject({
      caughtUp: true,
      groupId: groupReceipt.groupId,
      recentMessages: [
        {
          body: 'Membership does not make this private.',
          groupId: groupReceipt.groupId,
          mediaCid: MEDIA_CID.bytes,
          messageId: groupMessageReceipt.messageId,
          sender: account,
        },
      ],
    })
    const feed = await synchronizePostFeed(provider, LOCAL_CHAIN_ID, {
      storage: {
        databaseName: 'lifeinvader-anvil-post-feed',
        factory: new IDBFactory(),
        keyRange: IDBKeyRange,
      },
    })
    expect(feed.caughtUp).toBe(true)
    expect(feed.posts).toHaveLength(1)
    expect(feed.posts[0]).toMatchObject({
      author: account,
      blockNumber: postReceipt.blockNumber,
      body: '',
      mediaCid: MEDIA_CID.bytes,
      postId: 1n,
    })
    const commentStorage = {
      databaseName: 'lifeinvader-anvil-post-comments',
      factory: new IDBFactory(),
      keyRange: IDBKeyRange,
    }
    const comments = await synchronizePostCommentStream(
      provider,
      LOCAL_CHAIN_ID,
      { storage: commentStorage },
    )
    expect(comments).toMatchObject({
      caughtUp: true,
      projectionAnchor: { chainId: LOCAL_CHAIN_ID },
      recentComments: [
        {
          author: account,
          body: 'Nothing here is private.',
          commentId: 1n,
          mediaCid: '0x',
          postId: 1n,
        },
      ],
    })
    expect(comments.projectionAnchor).toBeDefined()
    if (!comments.projectionAnchor) {
      throw new Error('Caught-up comments did not issue a projection anchor.')
    }
    const commentProjection = await openPostCommentProjectionRun(
      comments.projectionAnchor,
      [1n],
      commentStorage,
    )
    await commentProjection.advance()
    await commentProjection.advance()
    expect(commentProjection.readComments(1n).comments).toMatchObject([
      {
        author: account,
        body: 'Nothing here is private.',
        commentId: 1n,
        mediaCid: '0x',
        postId: 1n,
      },
    ])
    const reactionStorage = {
      databaseName: 'lifeinvader-anvil-post-reactions',
      factory: new IDBFactory(),
      keyRange: IDBKeyRange,
    }
    const reactions = await synchronizePostReactionStream(
      provider,
      LOCAL_CHAIN_ID,
      { storage: reactionStorage },
    )
    expect(reactions.likes).toMatchObject({
      caughtUp: true,
      recentSignals: [
        { account, liked: false, postId: 1n },
        { account, liked: true, postId: 1n },
      ],
    })
    expect(reactions.reposts).toMatchObject({
      caughtUp: true,
      recentReposts: [{ account, postId: 1n }],
    })
    expect(reactions.projectionAnchor).toBeDefined()
    if (!reactions.projectionAnchor) {
      throw new Error('Caught-up reactions did not issue a projection anchor.')
    }
    const projection = await openPostReactionProjectionRun(
      reactions.projectionAnchor,
      reactionStorage,
    )
    await projection.advance()
    await projection.advance()
    await projection.advance()
    expect(projection.getSummary(1n, account)).toEqual({
      likeCount: 0n,
      likedByAccount: false,
      repostCount: 1n,
    })
    expect(
      PostReactionProjection.fromSnapshot(
        projection.projectionSnapshot,
      ).getSummary(1n, account),
    ).toEqual({
      likeCount: 0n,
      likedByAccount: false,
      repostCount: 1n,
    })
  })
})
