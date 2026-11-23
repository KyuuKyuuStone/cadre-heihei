/**
 * The shipped project-menu rows for `sidebar.workspaces.project.menu.item`.
 * Both raise browser-local dialog requests carried on the owner share, so the
 * dialogs keep living outside the menu that unmounts with its rows. Exported
 * only for the package's own slot registration, not as public client API.
 */
import { IconEditOutlineRegular, IconTrashOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectMenuItemProps } from '../contract/slots.ts'

/**
 * Menu row (order 200): dismiss the menu, then ask for the rename dialog.
 * @param props - owner share (with the rename request), menu open state, and the locale seat.
 * @returns the row.
 */
export function RenameWorkspaceMenuItem({ requestRename, useMenuOpenState, t }: ProjectMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      icon={<IconEditOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        requestRename()
      }}
    >
      {t('rename')}
    </MenuItemButton>
  )
}

/**
 * Menu row (order 400): dismiss the menu, then ask for the delete confirmation.
 * @param props - owner share (with the delete request), menu open state, and the locale seat.
 * @returns the row.
 */
export function DeleteWorkspaceMenuItem({ requestDelete, useMenuOpenState, t }: ProjectMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      icon={<IconTrashOutlineRegular />}
      danger
      onSelect={() => {
        setMenuOpen(false)
        requestDelete()
      }}
    >
      {t('delete.workspace')}
    </MenuItemButton>
  )
}
