export type ScreenId = 'conversation' | 'ledger' | 'roster'

export type AppState = {
  screen: ScreenId
}

export type AppAction = { type: 'screen'; screen: ScreenId }

/** 三屏是工作区切换而非路由堆叠（ADR-0020）：只保留当前屏。 */
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'screen':
      return state.screen === action.screen ? state : { ...state, screen: action.screen }
    default:
      return state
  }
}
