import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { App } from './app'

afterEach(cleanup)

describe('App', () => {
  it('states the deliberately public product boundary', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: /privacy was a bug/i }),
    ).toBeTruthy()
    expect(screen.getByText(/no delete button/i)).toBeTruthy()
    expect(screen.getByText(/unofficial parody project/i)).toBeTruthy()
  })

  it('does not offer wallet interaction before it is implemented', () => {
    render(<App />)

    const walletButton = screen.getByRole('button', {
      name: /invade with your wallet/i,
    })

    expect(walletButton.hasAttribute('disabled')).toBe(true)
  })
})
