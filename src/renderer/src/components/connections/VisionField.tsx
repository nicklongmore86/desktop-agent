import { useId, useState } from 'react'
import type { ConnectionInfo } from '../../../../shared/ipc-connections'
import { useApi } from '../../api'
import { useConnectionVision, VISION_CHANGED } from '../../attachments/use-vision'
import { useMounted } from './use-mounted'

/**
 * "This model can see images", for a connection whose model list does not say (local
 * servers, unlisted models). Off by default: images are never sent to a model nobody said
 * can read them. When the model list does say, that is shown instead of the switch.
 */
export function VisionField({
  connection,
}: {
  connection: ConnectionInfo
}): React.JSX.Element | null {
  const api = useApi()
  const mounted = useMounted()
  const hintId = useId()
  const vision = useConnectionVision(connection.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!vision?.configurable) return null
  if (vision.source === 'model')
    return (
      <p className="settings-hint">
        {vision.enabled
          ? 'The selected model can see images: attached images and images from tools are sent to it.'
          : 'The selected model cannot see images: it gets their names only.'}
      </p>
    )
  const change = (enabled: boolean): void => {
    setBusy(true)
    setError(null)
    api.connections.setVision(connection.id, enabled).then(
      () => {
        window.dispatchEvent(new Event(VISION_CHANGED))
        if (mounted.current) setBusy(false)
      },
      () => {
        if (!mounted.current) return
        setBusy(false)
        setError('The setting could not be saved. Try again.')
      },
    )
  }
  return (
    <div className="settings-row vision-field">
      <label>
        <input
          type="checkbox"
          checked={vision.setting}
          disabled={busy}
          aria-describedby={hintId}
          onChange={(event) => {
            change(event.target.checked)
          }}
        />{' '}
        This model can see images
      </label>
      <p id={hintId} className="settings-hint">
        Turn on only for a vision model (such as LLaVA, Qwen-VL or Gemma 3). Attached images and
        images from tools are then sent to it.
      </p>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
