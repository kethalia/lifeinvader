import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { decodeEventLog, getAddress, keccak256, type Hex } from 'viem'
import type { Eip1193Provider } from '../src/ethereum'
import {
  COMMENT_PUBLISHED_EVENT_ABI,
  COMMENT_PUBLISHED_TOPIC,
  FACTORY_ADDRESS,
  FACTORY_CODE_HASH,
  LIKE_SET_EVENT_ABI,
  LIKE_SET_TOPIC,
  LOCAL_RPC_URL,
  POST_PUBLISHED_EVENT_ABI,
  POST_PUBLISHED_TOPIC,
  PROTOCOL_ADDRESS,
  PROTOCOL_CODE_HASH,
} from '../src/protocol'

const LOCAL_CHAIN_ID_HEX = '0x7a69'
const LOCAL_ACCOUNT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const LOCAL_MNEMONIC =
  'test test test test test test test test test test test junk'
const TEST_PASSWORD = 'lifeinvader-local-only'
const POST_BODY = 'MetaMask smoke: privacy was a bug.'
const COMMENT_BODY = 'MetaMask comment: this is also permanently public.'

type JsonRpcResponse = {
  error?: { code?: number; message?: string }
  result?: unknown
}

function loopbackUrl(name: string, fallback: string) {
  const value = process.env[name] ?? fallback
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must be an unauthenticated HTTP loopback URL.`)
  }
  return url.toString()
}

async function rpc(url: string, method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok)
    throw new Error(`Local RPC returned HTTP ${response.status}.`)
  const payload = (await response.json()) as JsonRpcResponse
  if (payload.error) {
    throw new Error(
      `Local RPC ${method} failed: ${payload.error.message ?? 'unknown error'}`,
    )
  }
  if (!Object.hasOwn(payload, 'result')) {
    throw new Error(`Local RPC ${method} returned no result.`)
  }
  return payload.result
}

async function extensionPage(context: BrowserContext) {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 20_000 }))
  const extensionId = new URL(worker.url()).hostname
  const page =
    context
      .pages()
      .find((candidate) =>
        candidate.url().startsWith(`chrome-extension://${extensionId}/`),
      ) ?? (await context.newPage())
  if (!page.url().startsWith(`chrome-extension://${extensionId}/`)) {
    await page.goto(`chrome-extension://${extensionId}/home.html`)
  }
  return { extensionId, page }
}

async function waitForContextPage(
  context: BrowserContext,
  predicate: (page: Page) => boolean,
) {
  await expect
    .poll(() => context.pages().some(predicate), { timeout: 15_000 })
    .toBe(true)
  const page = context.pages().find(predicate)
  if (!page) throw new Error('The expected browser page disappeared.')
  return page
}

async function waitForSidePanelRequest(
  page: Page,
  extensionId: string,
  route: string,
  previousUrl: string,
) {
  const expectedPrefix = `chrome-extension://${extensionId}/sidepanel.html#/${route}/`
  await page.waitForURL(
    (url) =>
      url.toString() !== previousUrl &&
      url.toString().startsWith(expectedPrefix),
    { timeout: 30_000 },
  )
  await page.waitForLoadState('domcontentloaded')
  return page
}

async function waitForConnectedWallet(app: Page) {
  const walletPanel = app.locator('.wallet-connect')
  const connectionFacts = walletPanel.locator('.connection-facts')
  const connectionError = walletPanel.getByRole('alert')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect
      .poll(
        async () => {
          if (await connectionFacts.isVisible()) return 'connected'
          if (await connectionError.isVisible()) return 'error'
          return 'pending'
        },
        { timeout: 30_000 },
      )
      .not.toBe('pending')
    if (await connectionFacts.isVisible()) return connectionFacts
    const message = (await connectionError.textContent())?.trim()
    if (attempt === 0 && message === 'Wallet state read timed out.') {
      const reconnect = walletPanel.getByRole('button', {
        name: 'Connect MetaMask',
      })
      await expect(reconnect).toBeEnabled()
      await reconnect.click({ noWaitAfter: true })
      continue
    }
    throw new Error(`Lifeinvader did not connect MetaMask: ${message}`)
  }
  throw new Error('Lifeinvader did not connect MetaMask after one retry.')
}

async function confirmLocalTransaction(
  wallet: Page,
  extensionId: string,
  trigger: Locator,
) {
  await expect(trigger).toBeEnabled()
  const beforeRequest = wallet.url()
  await trigger.click({ noWaitAfter: true })
  const approval = await waitForSidePanelRequest(
    wallet,
    extensionId,
    'confirm-transaction',
    beforeRequest,
  )
  const confirmation = approval.getByTestId('parent-selector-confirmation-page')
  await expect(confirmation).toBeVisible({ timeout: 30_000 })
  await expect(confirmation).toContainText('Lifeinvader Local (Anvil)')
  const confirm = approval.getByTestId('confirm-footer-button')
  await expect(confirm).toBeEnabled()
  const requestUrl = approval.url()
  await confirm.click()
  await approval.waitForURL((url) => url.toString() !== requestUrl, {
    timeout: 30_000,
  })
}

function parseRpcLog(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local RPC returned a malformed log.')
  }
  const log = value as Record<string, unknown>
  if (
    typeof log.address !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(log.address) ||
    typeof log.data !== 'string' ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(log.data) ||
    typeof log.transactionHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(log.transactionHash) ||
    !Array.isArray(log.topics) ||
    log.topics.length === 0 ||
    !log.topics.every(
      (topic) => typeof topic === 'string' && /^0x[0-9a-f]{64}$/i.test(topic),
    )
  ) {
    throw new Error('Local RPC returned a malformed log.')
  }
  return {
    address: getAddress(log.address),
    data: log.data as Hex,
    transactionHash: log.transactionHash as Hex,
    topics: log.topics as [Hex, ...Hex[]],
  }
}

function parseRpcQuantity(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error(`Local RPC returned a malformed ${label}.`)
  }
  return value as Hex
}

function parseReceiptBlockNumber(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local RPC returned a malformed transaction receipt.')
  }
  return parseRpcQuantity(
    (value as Record<string, unknown>).blockNumber,
    'receipt block number',
  )
}

async function mineConfirmations(app: Page, rpcUrl: string) {
  await rpc(rpcUrl, 'anvil_mine', ['0xc'])
  const head = parseRpcQuantity(await rpc(rpcUrl, 'eth_blockNumber'), 'head')
  // MetaMask caches its head independently of direct Anvil RPC reads.
  await expect
    .poll(
      () =>
        app.evaluate(async () => {
          const wallet = (window as Window & { ethereum?: Eip1193Provider })
            .ethereum
          if (!wallet) throw new Error('MetaMask is no longer injected.')
          return await wallet.request({ method: 'eth_blockNumber' })
        }),
      { intervals: [1_000, 2_000], timeout: 30_000 },
    )
    .toBe(head)
}

async function includedActionLog(
  rpcUrl: string,
  feedback: Locator,
  topic: Hex,
) {
  const match = (await feedback.textContent())?.match(
    /included in block (\d+)\./i,
  )
  if (!match) throw new Error('The app did not render an inclusion block.')
  const blockNumber = `0x${BigInt(match[1]).toString(16)}` as Hex
  const logs = await rpc(rpcUrl, 'eth_getLogs', [
    {
      address: PROTOCOL_ADDRESS,
      fromBlock: blockNumber,
      toBlock: blockNumber,
      topics: [topic],
    },
  ])
  if (!Array.isArray(logs)) {
    throw new Error('Local RPC returned a malformed log collection.')
  }
  expect(logs).toHaveLength(1)
  const log = parseRpcLog(logs[0])
  expect(log.address).toBe(getAddress(PROTOCOL_ADDRESS))
  expect(
    parseReceiptBlockNumber(
      await rpc(rpcUrl, 'eth_getTransactionReceipt', [log.transactionHash]),
    ),
  ).toBe(blockNumber)
  return log
}

test('deploys, posts, comments, and reacts through MetaMask on Anvil', async ({}, testInfo) => {
  const extensionPathValue = process.env.LIFEINVADER_METAMASK_EXTENSION_PATH
  test.skip(
    !extensionPathValue,
    'Set LIFEINVADER_METAMASK_EXTENSION_PATH to an unpacked official MetaMask release.',
  )
  const extensionPath = resolve(extensionPathValue ?? '')
  await access(join(extensionPath, 'manifest.json'))
  const manifest = JSON.parse(
    await readFile(join(extensionPath, 'manifest.json'), 'utf8'),
  ) as { version?: unknown }
  expect(manifest.version).toMatch(/^13\./)

  const appUrl = loopbackUrl('LIFEINVADER_APP_URL', 'http://127.0.0.1:4173/')
  const rpcUrl = LOCAL_RPC_URL
  expect(await rpc(rpcUrl, 'web3_clientVersion')).toMatch(/^anvil\//i)
  expect(await rpc(rpcUrl, 'eth_chainId')).toBe(LOCAL_CHAIN_ID_HEX)
  const accounts = await rpc(rpcUrl, 'eth_accounts')
  expect(accounts).toEqual(expect.arrayContaining([LOCAL_ACCOUNT]))
  expect(await rpc(rpcUrl, 'eth_getCode', [PROTOCOL_ADDRESS, 'latest'])).toBe(
    '0x',
  )
  const factoryCode = await rpc(rpcUrl, 'eth_getCode', [
    FACTORY_ADDRESS,
    'latest',
  ])
  expect(factoryCode).toMatch(/^0x[0-9a-f]+$/i)
  expect(keccak256(factoryCode as Hex)).toBe(FACTORY_CODE_HASH)

  const snapshot = parseRpcQuantity(
    await rpc(rpcUrl, 'evm_snapshot'),
    'snapshot id',
  )
  const profilePath = await mkdtemp(join(tmpdir(), 'lifeinvader-metamask-'))
  let context: BrowserContext | undefined
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      ...(process.env.LIFEINVADER_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.LIFEINVADER_CHROMIUM_EXECUTABLE }
        : {}),
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
      ],
      channel: 'chromium',
      headless: true,
      viewport: { height: 900, width: 1440 },
    })
    const { extensionId, page: wallet } = await extensionPage(context)
    await wallet.screenshot({
      path: testInfo.outputPath('metamask-welcome.png'),
    })
    expect(extensionId).toMatch(/^[a-p]{32}$/)
    await expect(wallet).toHaveTitle(/MetaMask/i)
    await expect(
      wallet.getByRole('button', { name: 'I have an existing wallet' }),
    ).toBeVisible()
    await wallet
      .getByRole('button', { name: 'I have an existing wallet' })
      .click()
    await wallet
      .getByRole('button', { name: 'Import using Secret Recovery Phrase' })
      .click()
    const recoveryPhrase = wallet.getByTestId('srp-input-import__srp-note')
    await expect(recoveryPhrase).toBeVisible()
    await recoveryPhrase.pressSequentially(LOCAL_MNEMONIC, { delay: 5 })
    const continueButton = wallet.getByRole('button', { name: 'Continue' })
    await expect(continueButton).toBeEnabled()
    await continueButton.click()
    await expect(recoveryPhrase).toBeHidden()
    const passwords = wallet.locator('input[type="password"]')
    await expect(passwords).toHaveCount(2)
    await passwords.nth(0).fill(TEST_PASSWORD)
    await passwords.nth(1).fill(TEST_PASSWORD)
    await wallet
      .getByRole('checkbox', {
        name: /If I lose this password, MetaMask can’t reset it/i,
      })
      .check()
    await wallet.getByRole('button', { name: 'Create password' }).click()
    await expect(passwords.nth(0)).toBeHidden()
    await wallet.getByRole('button', { name: 'Maybe later' }).click()
    await expect(
      wallet.getByRole('button', { name: 'Maybe later' }),
    ).toBeHidden()
    const telemetry = wallet.getByRole('checkbox').nth(0)
    await expect(telemetry).toBeChecked()
    await telemetry.uncheck()
    const marketing = wallet.getByRole('checkbox').nth(1)
    await expect(marketing).not.toBeChecked()
    await wallet.getByRole('button', { name: 'Continue' }).click()
    await expect(telemetry).toBeHidden()
    await wallet.getByRole('button', { name: 'Open wallet' }).click()
    const walletHome = await waitForContextPage(
      context,
      (candidate) =>
        candidate.url() === `chrome-extension://${extensionId}/home.html#/`,
    )
    await expect(walletHome.getByText('Account 1')).toBeVisible()
    await walletHome.goto(`chrome-extension://${extensionId}/sidepanel.html`)
    await walletHome.waitForLoadState('domcontentloaded')

    const app = await context.newPage()
    await app.goto(appUrl)
    const connect = app.getByRole('button', { name: 'Connect MetaMask' })
    await expect(connect).toBeVisible()
    const beforeConnect = walletHome.url()
    await connect.click({ noWaitAfter: true })
    const approval = await waitForSidePanelRequest(
      walletHome,
      extensionId,
      'connect',
      beforeConnect,
    )
    const connectConfirmation = approval.getByTestId(
      'parent-selector-connect-page',
    )
    await expect(connectConfirmation).toBeVisible()
    await expect(
      approval.getByTestId('multichain-account-cell-name-dev1'),
    ).toBeVisible()
    const confirmConnect = approval.getByTestId('confirm-btn')
    await expect(confirmConnect).toBeEnabled()
    await confirmConnect.click()
    await expect(connectConfirmation).toBeHidden({ timeout: 30_000 })
    const connectionFacts = await waitForConnectedWallet(app)
    await expect(connectionFacts).toContainText(LOCAL_ACCOUNT.slice(-4))
    const switchChain = app.getByRole('button', {
      name: /Switch to local Anvil|Verify local Anvil/,
    })
    await expect(switchChain).toBeVisible()
    const beforeNetwork = walletHome.url()
    await switchChain.click({ noWaitAfter: true })
    const networkApproval = await waitForSidePanelRequest(
      walletHome,
      extensionId,
      'confirm-transaction',
      beforeNetwork,
    )
    const networkConfirmation = networkApproval.getByTestId(
      'parent-selector-confirmation-page',
    )
    await expect(networkConfirmation).toBeVisible({ timeout: 30_000 })
    await expect(networkConfirmation).toContainText(
      'Add Lifeinvader Local (Anvil)',
    )
    await expect(networkConfirmation).toContainText('127.0.0.1:8545')
    const confirmNetwork = networkApproval.getByTestId('confirm-footer-button')
    await expect(confirmNetwork).toBeEnabled()
    const networkRequestUrl = networkApproval.url()
    await confirmNetwork.click()
    await networkApproval.waitForURL(
      (url) => url.toString() !== networkRequestUrl,
      { timeout: 30_000 },
    )
    await expect(app.locator('.connection-facts')).toContainText('31337', {
      timeout: 30_000,
    })

    await expect(
      app.getByRole('button', { name: 'Local Anvil verified' }),
    ).toBeVisible()
    const deploy = app.getByRole('button', { name: 'Deploy protocol here' })
    await expect(deploy).toBeEnabled()
    const beforeDeployment = walletHome.url()
    await deploy.click({ noWaitAfter: true })
    const deploymentApproval = await waitForSidePanelRequest(
      walletHome,
      extensionId,
      'confirm-transaction',
      beforeDeployment,
    )
    const deploymentConfirmation = deploymentApproval.getByTestId(
      'parent-selector-confirmation-page',
    )
    await expect(deploymentConfirmation).toBeVisible({ timeout: 30_000 })
    await expect(deploymentConfirmation).toContainText(
      'Lifeinvader Local (Anvil)',
    )
    const confirmDeployment = deploymentApproval.getByTestId(
      'confirm-footer-button',
    )
    await expect(confirmDeployment).toBeEnabled()
    await confirmDeployment.click()
    await expect(app.getByText(/Included in block \d+/)).toBeVisible({
      timeout: 30_000,
    })
    await expect(
      app.getByText('Verified Lifeinvader v1 code is ready.'),
    ).toBeVisible({ timeout: 30_000 })
    const protocolCode = await rpc(rpcUrl, 'eth_getCode', [
      PROTOCOL_ADDRESS,
      'latest',
    ])
    expect(protocolCode).toMatch(/^0x[0-9a-f]+$/i)
    expect(keccak256(protocolCode as Hex)).toBe(PROTOCOL_CODE_HASH)

    const composer = app.getByLabel('Permanent public statement')
    await composer.fill(POST_BODY)
    const publish = app.getByRole('button', { name: 'Publish on-chain' })
    await expect(publish).toBeEnabled()
    const beforePost = walletHome.url()
    await publish.click({ noWaitAfter: true })
    const postApproval = await waitForSidePanelRequest(
      walletHome,
      extensionId,
      'confirm-transaction',
      beforePost,
    )
    const postConfirmation = postApproval.getByTestId(
      'parent-selector-confirmation-page',
    )
    await expect(postConfirmation).toBeVisible({ timeout: 30_000 })
    await expect(postConfirmation).toContainText('Lifeinvader Local (Anvil)')
    const confirmPost = postApproval.getByTestId('confirm-footer-button')
    await expect(confirmPost).toBeEnabled()
    const postRequestUrl = postApproval.url()
    await confirmPost.click()
    await postApproval.waitForURL((url) => url.toString() !== postRequestUrl, {
      timeout: 30_000,
    })
    await expect(composer).toHaveValue('', { timeout: 30_000 })
    const postResult = app.locator('.transaction-result')
    await expect(postResult).toContainText(/Included in block \d+/)
    const postTransactionHash = await postResult
      .locator('code')
      .getAttribute('title')
    if (
      !postTransactionHash ||
      !/^0x[0-9a-f]{64}$/i.test(postTransactionHash)
    ) {
      throw new Error('The app rendered a malformed post transaction hash.')
    }
    const postBlock = parseReceiptBlockNumber(
      await rpc(rpcUrl, 'eth_getTransactionReceipt', [postTransactionHash]),
    )

    const rawLogs = await rpc(rpcUrl, 'eth_getLogs', [
      {
        address: PROTOCOL_ADDRESS,
        fromBlock: postBlock,
        toBlock: postBlock,
        topics: [POST_PUBLISHED_TOPIC],
      },
    ])
    if (!Array.isArray(rawLogs)) {
      throw new Error('Local RPC returned a malformed log collection.')
    }
    expect(rawLogs).toHaveLength(1)
    const log = parseRpcLog(rawLogs[0])
    expect(log.address).toBe(getAddress(PROTOCOL_ADDRESS))
    expect(log.transactionHash.toLowerCase()).toBe(
      postTransactionHash.toLowerCase(),
    )
    const decoded = decodeEventLog({
      abi: POST_PUBLISHED_EVENT_ABI,
      data: log.data,
      topics: log.topics,
    })
    expect(decoded.eventName).toBe('PostPublished')
    expect(decoded.args.postId).toBe(1n)
    expect(decoded.args.author).toBe(getAddress(LOCAL_ACCOUNT))
    expect(decoded.args.body).toBe(POST_BODY)
    expect(decoded.args.mediaCid).toBe('0x')

    await mineConfirmations(app, rpcUrl)
    const refreshFeed = app.locator('.feed-controls').getByRole('button')
    await expect(refreshFeed).toBeEnabled()
    await refreshFeed.click()
    await expect(app.locator('.post-body')).toHaveText(POST_BODY)
    await app
      .getByRole('button', { name: 'Write comment for post 1', exact: true })
      .click()
    await app
      .getByLabel('Permanent public comment', { exact: true })
      .fill(COMMENT_BODY)
    await confirmLocalTransaction(
      walletHome,
      extensionId,
      app.getByRole('button', { name: 'Publish comment on-chain' }),
    )
    const actionFeedback = app.locator('.post-action-complete')
    await expect(actionFeedback).toContainText(
      /Comment for post #1 was included in block \d+\./,
      { timeout: 30_000 },
    )
    const commentLog = await includedActionLog(
      rpcUrl,
      actionFeedback,
      COMMENT_PUBLISHED_TOPIC,
    )
    const commentEvent = decodeEventLog({
      abi: COMMENT_PUBLISHED_EVENT_ABI,
      data: commentLog.data,
      topics: commentLog.topics,
    })
    expect(commentEvent.args).toEqual({
      author: getAddress(LOCAL_ACCOUNT),
      body: COMMENT_BODY,
      commentId: 1n,
      mediaCid: '0x',
      postId: 1n,
    })

    await mineConfirmations(app, rpcUrl)
    await app.getByRole('button', { name: 'Load comment histories' }).click()
    const advanceComments = app.getByRole('button', {
      name: 'Process next local comment page',
    })
    // One bounded cache page, then one separate authentication step.
    await advanceComments.click()
    await advanceComments.click()
    await expect(app.getByText(COMMENT_BODY, { exact: true })).toBeVisible()

    for (const liked of [true, false]) {
      const action = liked ? 'like' : 'unlike'
      await confirmLocalTransaction(
        walletHome,
        extensionId,
        app.getByRole('button', {
          name: `Record ${action} for comment 1`,
          exact: true,
        }),
      )
      await expect(actionFeedback).toContainText(
        new RegExp(`^${liked ? 'Like' : 'Unlike'} for comment #1 was included`),
        { timeout: 30_000 },
      )
      const reactionLog = await includedActionLog(
        rpcUrl,
        actionFeedback,
        LIKE_SET_TOPIC,
      )
      const reaction = decodeEventLog({
        abi: LIKE_SET_EVENT_ABI,
        data: reactionLog.data,
        topics: reactionLog.topics,
      })
      expect(reaction.args).toEqual({
        account: getAddress(LOCAL_ACCOUNT),
        contentId: 1n,
        contentKind: 1,
        liked,
      })
    }
    await app.screenshot({
      fullPage: true,
      path: testInfo.outputPath('lifeinvader-confirmed.png'),
    })
  } finally {
    try {
      await context?.close()
    } finally {
      try {
        expect(await rpc(rpcUrl, 'evm_revert', [snapshot])).toBe(true)
        expect(
          await rpc(rpcUrl, 'eth_getCode', [PROTOCOL_ADDRESS, 'latest']),
        ).toBe('0x')
      } finally {
        await rm(profilePath, { force: true, recursive: true })
      }
    }
  }
})
