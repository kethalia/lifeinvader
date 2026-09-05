import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach } from 'vitest'

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  })
  Object.defineProperty(globalThis, 'IDBKeyRange', {
    configurable: true,
    value: IDBKeyRange,
  })
})
