import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatStore } from '../contract/slots.ts'
import css from './CadreInternalEventsToggle.module.css'

export function CadreInternalEventsToggle({
  useStore, actions, t,
}: PropsStore<ChatStore> & PropsLocale<'chat'>) {
  const visible = useStore(state => state.internalEventsVisible)
  return (
    <div className={css.bar}>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={visible}
        data-cadre-internal-toggle
        onClick={() => { actions.setInternalEventsVisible(!visible) }}
      >
        {visible ? t('internal.toggle.hide') : t('internal.toggle.show')}
      </Button>
    </div>
  )
}
