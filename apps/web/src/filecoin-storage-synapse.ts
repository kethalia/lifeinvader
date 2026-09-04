import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_MAINNET_CHAIN_ID,
  getFilecoinStorageNetwork,
  type FilecoinStorageNetwork,
} from './filecoin-storage'

type SynapseChain = (typeof import('@filoz/synapse-sdk'))['calibration']

export type FilecoinStorageSynapseTemplates = {
  calibration: SynapseChain
  mainnet: SynapseChain
}

/**
 * Select a supported Synapse chain while replacing every storage address with
 * the exact graph that Lifeinvader preflights. This keeps SDK updates from
 * silently changing a transaction target.
 */
export function bindFilecoinStorageSynapseChain(
  chainId: bigint,
  templates: FilecoinStorageSynapseTemplates,
): { chain: SynapseChain; network: FilecoinStorageNetwork } | undefined {
  const network = getFilecoinStorageNetwork(chainId)
  if (!network) return undefined
  const template =
    chainId === FILECOIN_MAINNET_CHAIN_ID
      ? templates.mainnet
      : chainId === FILECOIN_CALIBRATION_CHAIN_ID
        ? templates.calibration
        : undefined
  if (!template) return undefined

  return {
    chain: {
      ...template,
      contracts: Object.fromEntries(
        Object.entries(template.contracts).map(([name, contract]) => [
          name,
          name in network.contracts
            ? {
                ...contract,
                address:
                  network.contracts[
                    name as keyof FilecoinStorageNetwork['contracts']
                  ],
              }
            : contract,
        ]),
      ) as SynapseChain['contracts'],
    },
    network,
  }
}
