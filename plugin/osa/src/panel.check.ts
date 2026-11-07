import { defineCheck } from 'orca/testing'
const status = { stateDir: '/state', tickets: [{ id: 'task-1', title: '整理项目文档', attention: { question: '需要包含哪些范围？' }, assignments: [], inputs: [], origin: { triggerIds: [] }, undelivered: [] }], projects: { projects: [{ id: 'p', name: '示例项目' }], components: [], locations: [], tasks: [{ ticket: { id: 'task-1' }, context: { target: { projectId: 'p' } } }] }, candidates: [] }
export default defineCheck({ overview: { requests: { 'osa.call': () => status } } })
