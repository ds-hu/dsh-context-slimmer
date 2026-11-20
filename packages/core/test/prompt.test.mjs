import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SLIM_PARAMETER_DESCRIPTIONS,
  SLIM_PARAMETERS,
  SLIM_SYSTEM_PROMPT_EN,
  SLIM_SYSTEM_PROMPT_ZH,
  SLIM_TOOL_DESCRIPTION,
  STRUCTURED_OUTPUT_TOOL,
  DATA_BOUNDARY,
  buildSlimTaskMessage,
  renderCandidates,
  renderPayload,
  renderRecent,
  selectSystemPrompt,
} from '../../lib/prompt.js'
import { CHARS_PER_TOKEN } from '../../lib/plan.js'

// Snapshot assertions from docs/research/prompt-final.md §5 (v1.1 baseline,
// with the Lead-approved R5 rename of the submission tool to the native
// structured_output tool — see docs/dev-notes.md DEV-6).
test('Chinese system prompt keeps the pinned length and token budget', () => {
  assert.equal(SLIM_SYSTEM_PROMPT_ZH.length, 1199)
  assert.equal(Math.ceil(SLIM_SYSTEM_PROMPT_ZH.length / CHARS_PER_TOKEN), 300)
  assert.equal(SLIM_SYSTEM_PROMPT_ZH.includes('structured_output'), true)
  assert.equal(SLIM_SYSTEM_PROMPT_ZH.includes('slim_tool_results'), false)
})

test('English system prompt stays within the parity budget', () => {
  assert.equal(SLIM_SYSTEM_PROMPT_EN.length, 2819)
  const words = SLIM_SYSTEM_PROMPT_EN.split(/\s+/).filter(Boolean).length
  assert.ok(words >= 300 && words <= 500, `English prompt has ${words} words`)
  assert.match(SLIM_SYSTEM_PROMPT_EN, /structured output/i)
})

test('all required anchors are present', () => {
  for (const anchor of [
    '【角色】',
    '【输入】',
    '【判定顺序（先匹配）】',
    '【硬规则】',
    '【输出契约】',
    'structured_output',
    '只调用一次',
    '0 基',
    '未列出=保留',
    'KEEP',
    '[elided by context-slimmer]',
    '不得把失败写成成功',
    'index 不得重复/越界',
    '300 tokens',
    'items 可为空',
  ]) {
    assert.equal(SLIM_SYSTEM_PROMPT_ZH.includes(anchor), true, `missing anchor ${anchor}`)
  }
})

test('classification waterfall order is preserved', () => {
  const order = ['安全/敏感', '失败/报错', '已被取代', '可重算 bulk', '部分相关', '网页/搜索', '写入/编辑', '超大输出', '无关', '模糊']
  const positions = order.map((label) => SLIM_SYSTEM_PROMPT_ZH.indexOf(label))
  assert.equal(positions.includes(-1), false, 'every classification label must exist')
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index - 1] < positions[index], `classification order broken at ${order[index]}`)
  }
})

test('forbidden legacy vocabulary is absent', () => {
  for (const forbidden of ['keep', 'class', 'confidence', 'TRIM', 'REPLACE', '\uFFFD']) {
    assert.equal(SLIM_SYSTEM_PROMPT_ZH.includes(forbidden), false, `forbidden token ${forbidden}`)
  }
})

test('tool description and parameter descriptions stay verbatim', () => {
  assert.ok(SLIM_TOOL_DESCRIPTION.split(/\s+/).filter(Boolean).length >= 100)
  assert.ok(SLIM_TOOL_DESCRIPTION.split(/\s+/).filter(Boolean).length <= 120)
  assert.equal(SLIM_PARAMETER_DESCRIPTIONS.text.includes('Hard limit: <=300 tokens and <=50% of the original'), true)
  assert.equal(SLIM_PARAMETER_DESCRIPTIONS.summary.includes('shown in the UI details and run metadata.'), true)
  assert.deepEqual(Object.keys(SLIM_PARAMETERS.properties).sort(), ['items', 'summary'])
  assert.equal(SLIM_PARAMETERS.additionalProperties, false)
  assert.equal(SLIM_PARAMETERS.properties.items.items.properties.op.enum.join(','), 'drop,trim')
  assert.equal(JSON.stringify(SLIM_PARAMETERS).includes('maxItems'), false)
})

test('renderPayload formats candidates with [#index] and never leaks seq/callId', () => {
  const payload = renderPayload({
    task: '修复登录回归',
    constraints: ['不要改测试'],
    recent: [{ index: 0, tool: 'bash', isError: false, chars: 100 }],
    candidates: [
      { index: 0, tool: 'bash', isError: false, chars: 4000, text: 'x'.repeat(50) },
      { index: 1, tool: 'read_file', isError: true, chars: 9000, text: 'y'.repeat(50) },
    ],
  })
  assert.equal(payload.startsWith(DATA_BOUNDARY), true)
  for (const block of ['[TASK]', '[CONSTRAINTS]', '[RECENT]', '[CANDIDATES]']) assert.equal(payload.includes(block), true)
  assert.equal(payload.includes('[#0] tool=bash error=false chars=4000'), true)
  assert.equal(payload.includes('[#1] tool=read_file error=true chars=9000'), true)
  assert.equal(payload.includes('recent[#0]'), true)
  assert.equal(/callId|seq=/.test(payload), false)
  const candidateBlocks = renderCandidates([{ index: 2, tool: 'bash', isError: false, chars: 1, text: 'z' }])
  assert.equal(candidateBlocks.startsWith('[#2] tool=bash'), true)
  assert.equal(renderRecent([]), '（无）')
})

test('buildSlimTaskMessage joins the system prompt preamble with the payload', () => {
  const blocks = buildSlimTaskMessage({
    locale: 'zh-CN',
    task: 'task',
    constraints: [],
    recent: [],
    candidates: [{ index: 0, tool: 'bash', isError: false, chars: 300, text: 'abc' }],
  })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text.startsWith(SLIM_SYSTEM_PROMPT_ZH), true)
  assert.equal(blocks[0].text.includes(DATA_BOUNDARY), true)
  assert.equal(blocks[0].text.indexOf(DATA_BOUNDARY) > blocks[0].text.indexOf(SLIM_SYSTEM_PROMPT_ZH), true)
  assert.equal(selectSystemPrompt('en-US'), SLIM_SYSTEM_PROMPT_EN)
  assert.equal(selectSystemPrompt('zh-CN'), SLIM_SYSTEM_PROMPT_ZH)
  assert.equal(selectSystemPrompt(undefined), SLIM_SYSTEM_PROMPT_ZH)
  assert.equal(STRUCTURED_OUTPUT_TOOL, 'structured_output')
})
