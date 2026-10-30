// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { UserContent } from '../src/client/chat/UserContent.tsx'
import { CadreInternalEventsToggle } from '../src/client/chat/CadreInternalEventsToggle.tsx'
import { createChatStore } from '../src/client/stores.ts'

const t = ((key: string) => ({
  'internal.toggle.show': '显示内部事件',
  'internal.toggle.hide': '隐藏内部事件',
}[key] ?? key)) as never

function content(text: string) {
  return { text, attachments: [], extraBlocks: [] }
}

function mount(text: string) {
  const chat = createChatStore().create()
  const userProps = {
    content: content(text),
    loadImage: vi.fn(),
    facts: {},
    interactive: false,
    ellipsis: false,
    renderSlot: () => null,
    renderFactorySlot: (_name: string, owner: { text: string }) => <span>{owner.text}</span>,
    t,
    useStore: bindSnapshotSelector(chat),
  } as unknown as ComponentProps<typeof UserContent>
  const toggleProps = {
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    t,
  } as unknown as ComponentProps<typeof CadreInternalEventsToggle>
  const renderContent = (): ReactNode => <UserContent {...userProps} />
  const view = render(
    <>
      {renderContent()}
      <CadreInternalEventsToggle {...toggleProps} />
    </>,
  )
  return { chat, view }
}

afterEach(cleanup)

describe('Cadre internal events', () => {
  it('hides the reserved internal message by default', () => {
    mount('【主管内部】模型正在重试')
    expect(screen.queryByText(/模型正在重试/)).toBeNull()
    expect(document.querySelector('[data-cadre-internal-hidden]')).toBeTruthy()
  })

  it('shows internal messages weakly after the explicit toggle', () => {
    mount('【主管内部】模型正在重试')
    fireEvent.click(screen.getByRole('button', { name: '显示内部事件' }))
    expect(screen.getByText(/模型正在重试/)).toBeTruthy()
    expect(document.querySelector('[data-internal-event="true"]')).toBeTruthy()
  })

  it('never hides ordinary user or decision messages', () => {
    const { view } = mount('【需要您决定】请选择 A 或 B')
    expect(screen.getByText(/请选择 A 或 B/)).toBeTruthy()
    view.unmount()
    render(<UserContent {...({
      content: content('我自己的消息'),
      loadImage: vi.fn(), facts: {}, interactive: false, ellipsis: false,
      renderSlot: () => null,
      renderFactorySlot: (_name: string, owner: { text: string }) => <span>{owner.text}</span>,
      t,
      useStore: (() => false) as never,
    } as unknown as ComponentProps<typeof UserContent>)} />)
    expect(screen.getByText('我自己的消息')).toBeTruthy()
  })
})
