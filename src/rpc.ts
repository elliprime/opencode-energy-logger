import { Rpc } from '@opencode/plugin/rpc'

const voidInput = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

const enabledOutput = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
  },
  required: ['enabled'],
  additionalProperties: false,
}

const toggleFailure = {
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
  additionalProperties: false,
}

export const Energy = Rpc.define({
  id: 'energy-logger',
  methods: {
    get: {
      input: voidInput,
      output: enabledOutput,
    },
    toggle: {
      input: voidInput,
      output: enabledOutput,
      errors: {
        toggle_failed: toggleFailure,
      },
    },
  },
  events: {
    toggled: {
      schema: {
        type: 'object',
        properties: {
          directory: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['directory', 'enabled'],
        additionalProperties: false,
      },
    },
  },
})
