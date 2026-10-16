import type { ConversationSummary, HistoryState } from '../../../../shared/ipc'
import { HistoryList } from '../HistoryList'
import type { PaneVariant } from './shell-context'
import { useShell } from './shell-context'

/**
 * The chats in the left sidebar (and its drawer): New chat plus the saved-chat list.
 * This is the slot the projects / pins redesign replaces; the sidebar frame around
 * it (brand, footer, resizing, drawers) does not change.
 */
export function ChatsPane({
  variant,
  history,
  switching,
  onNewChat,
  onOpen,
  onRename,
  onDelete,
}: {
  variant: PaneVariant
  history: HistoryState
  switching: boolean
  onNewChat: () => void
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<boolean>
  onDelete: (conversation: ConversationSummary) => void
}): React.JSX.Element {
  const { closeDrawer } = useShell()
  return (
    <>
      <button className="sidebar-new" type="button" disabled={switching} onClick={onNewChat}>
        New chat
      </button>
      <HistoryList
        history={history}
        busy={switching}
        showLabel={variant === 'docked'}
        onOpen={(id) => {
          closeDrawer()
          onOpen(id)
        }}
        onRename={onRename}
        onDelete={onDelete}
      />
    </>
  )
}
