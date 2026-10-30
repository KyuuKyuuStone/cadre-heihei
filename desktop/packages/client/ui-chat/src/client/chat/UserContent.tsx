/** Reusable user contents inside a caller-owned message row. */
import { Fragment } from 'react'
import type { FactoryComponentPropsOf, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { fileExtension, FileTypeIcon, fileSizeText, JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatStore } from '../contract/slots.ts'
import { isCadreInternalEvent } from './internal-events.ts'
import css from './MessageItem.module.css'

const EMPTY_LABELS: readonly string[] = []

type UserContentProps = Omit<FactoryComponentPropsOf<'conversation.chat.user.content'>, 'useStore'>
  & { readonly useStore?: PropsStore<ChatStore>['useStore'] }

/**
 * Render prepared text, ordered attachments, and references without message chrome.
 * The caller owns row identity, pending/echo state, time, and message actions.
 * Supervisor-internal messages are collapsed by default and revealed through
 * the Chat store's explicit toggle; ordinary user messages are untouched.
 * @param props - prepared content, facts, authorized image loader, and framework Factory/locale/store seats.
 * @returns the content stack using the existing user-message layout.
 */
export function UserContent({
  content, loadImage, facts, interactive = false, ellipsis = false, renderSlot, renderFactorySlot, t, useStore,
}: UserContentProps) {
  const { text, attachments, extraBlocks, referenceLabels = EMPTY_LABELS } = content
  const compactImages = attachments.length > 1
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || extraBlocks.length > 0
  const internal = isCadreInternalEvent(text)
  const internalVisible = (useStore ?? (() => false))(state => state.internalEventsVisible)
  if (internal && !internalVisible) {
    // The row owns its chrome; this marker lets MessageItem.module.css collapse
    // the whole row without hiding ordinary user messages.
    return <span data-cadre-internal-hidden hidden />
  }
  return (
    <div className={internal ? `${css.userStack} ${css.internalEvent}` : css.userStack} data-internal-event={internal || undefined}>
      {attachments.length > 0 && (
        <div className={css.attachmentRow} data-message-attachments>
          {attachments.map((attachment, index) => attachment.type === 'image'
            ? (
              <Fragment key={`image:${index}`}>
                {renderSlot('conversation.chat.user.images', {
                  images: [attachment.image], loadImage, align: 'end', compact: compactImages,
                })}
              </Fragment>
            )
            : (
              <span key={`file:${index}`} className={css.fileCard} title={attachment.file.name}>
                <FileTypeIcon path={attachment.file.name} className={css.fileIcon} />
                <span className={css.fileContent}>
                  <span className={css.fileName}>{attachment.file.name}</span>
                  <span className={css.fileMeta}>
                    {[fileExtension(attachment.file.name).toUpperCase().slice(0, 8), fileSizeText(attachment.file.bytes)]
                      .filter(Boolean).join(' ')}
                  </span>
                </span>
              </span>
            ))}
        </div>
      )}
      {showBubble && <div className={css.bubble}>
        {renderFactorySlot('conversation.user.text', { text, facts, interactive, ellipsis })}
        {extraBlocks.map((block, index) => (
          <JsonBlock key={index} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />
        ))}
      </div>}
      {referenceLabels.length > 0 && (
        <div className={css.referenceSummary}>
          {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
        </div>
      )}
    </div>
  )
}
