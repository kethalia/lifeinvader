const MAX_GROUP_ID = (1n << 256n) - 1n

export function parseGroupIdInput(value: string) {
  const candidate = value.trim()
  if (!/^[1-9][0-9]{0,77}$/.test(candidate)) {
    throw new Error('Enter a positive decimal group ID.')
  }
  const groupId = BigInt(candidate)
  if (groupId > MAX_GROUP_ID) {
    throw new Error('The group ID exceeds the EVM uint256 limit.')
  }
  return groupId
}
