import { useContext } from 'react'
import { useStdin as useFallbackStdin } from 'ink'
import StdinContext from '../components/StdinContext.js'

/**
 * `useStdin` is a React hook, which exposes stdin stream.
 */
const useStdin = () => {
  const local = useContext(StdinContext)
  const fallback = useFallbackStdin()
  if (local.internal_querier !== null || fallback.stdin === process.stdin) {
    return local
  }
  return {
    ...local,
    stdin: fallback.stdin,
    setRawMode: fallback.setRawMode,
    isRawModeSupported: fallback.isRawModeSupported,
  }
}
export default useStdin
