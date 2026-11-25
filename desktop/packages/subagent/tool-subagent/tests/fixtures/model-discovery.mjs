/** Deterministic metadata lookups for the model-discovery transcript. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class DiscoveryAdapter extends LlmAdapter {
  async listModels(provider) {
    return [
      { provider, id: 'healthy', name: 'Healthy' },
      { provider, id: 'unauthorized', name: 'Unauthorized' },
    ]
  }

  async resolveModel(provider, model) {
    if (model === 'removed') throw new Error('model was removed')
    return { provider, id: model, name: 'Healthy' }
  }

  async *stream() {
    throw new Error('metadata-only fixture does not serve model requests')
  }
}

export const name = 'discovery-fixture'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['discovery-fixture'], new DiscoveryAdapter())
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    if (turn === 1 && step === 1) {
      agent.session.append('subagent/model-selection-policy', {
        allowedModels: [
          { provider: 'discovery-fixture', model: 'removed' },
          { provider: 'discovery-fixture', model: 'healthy' },
        ],
      })
    }
    return next()
  })
}
