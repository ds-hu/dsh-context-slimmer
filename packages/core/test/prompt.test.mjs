import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DATA_BOUNDARY,
  SYSTEM_PROMPTS,
  buildPlannerInstruction,
  renderCandidates,
  renderPayload,
  renderRecent,
  selectSystemPrompt,
} from '../lib/prompt.js'

const POLICIES = ['conservative', 'balanced', 'aggressive']

test('v1.4 prompts are minimal: one JSON object, no tools, no long tables', () => {
  for (const language of ['zh', 'en']) {
    for (const policy of POLICIES) {
      const prompt = SYSTEM_PROMPTS[language][policy]
      assert.equal(typeof prompt, 'string')
      assert.equal(prompt.length <= 2500, true, `${language}/${policy} prompt is ${prompt.length} chars`)
      assert.equal(prompt.includes('structured_output'), false)
      assert.equal(prompt.includes('slim_tool_results'), false)
      assert.equal(prompt.includes('JSON'), true)
      assert.equal(prompt.includes('callId'), true)
    }
  }
  // The conservative policy must demand verifiable evidence and allow "empty plan".
  const conservative = SYSTEM_PROMPTS.zh.conservative
  for (const anchor of ['duplicateOf', 'supersededBy', 'evidence.kind', '无法证明安全', '{"summary":"本次无改动","items":[]}', 'reason≤20'])
    assert.equal(conservative.includes(anchor), true, `missing anchor: ${anchor}`)
  assert.equal(conservative.includes('对话') || conservative.includes('不要任何解释'), true)
  assert.equal(conservative.includes('trim 一律拒绝'), true)
  // Minimal-output requirement: no explanation/thinking.
  assert.equal(SYSTEM_PROMPTS.en.conservative.includes('no explanation'), true)
  assert.equal(SYSTEM_PROMPTS.en.conservative.includes('reason<=20'), true)
  // Balanced/aggressive document their trim caps.
  assert.equal(SYSTEM_PROMPTS.zh.balanced.includes('4000'), true)
  assert.equal(SYSTEM_PROMPTS.zh.aggressive.includes('1200'), true)
  assert.equal(SYSTEM_PROMPTS.en.balanced.includes('4000'), true)
})

test('selectSystemPrompt picks locale and policy, falling back to conservative', () => {
  assert.equal(selectSystemPrompt(undefined), SYSTEM_PROMPTS.zh.conservative)
  assert.equal(selectSystemPrompt('en-US', 'balanced'), SYSTEM_PROMPTS.en.balanced)
  assert.equal(selectSystemPrompt('zh-CN', 'aggressive'), SYSTEM_PROMPTS.zh.aggressive)
  assert.equal(selectSystemPrompt('fr', 'bogus'), SYSTEM_PROMPTS.zh.conservative)
})

test('candidates expose index/tool/isError/chars/callId (evidence refs) and never the seq', () => {
  const rendered = renderCandidates([
    { index: 0, tool: 'bash', isError: false, chars: 100, callId: 'call_abc', text: 'hello' },
  ])
  assert.equal(rendered.includes('[#0] tool=bash error=false chars=100 callId=call_abc'), true)
  assert.equal(rendered.includes('seq='), false)
})

test('payload renders task, constraints, recent and candidates under one data boundary', () => {
  const payload = renderPayload({
    task: 'fix the bug',
    constraints: ['do not touch tests'],
    recent: [{ index: 0, tool: 'bash', isError: true, chars: 12 }],
    candidates: [{ index: 0, tool: 'read_file', isError: false, chars: 99, callId: 'c1', text: 'body' }],
  })
  assert.equal(payload.startsWith(DATA_BOUNDARY), true)
  assert.equal(payload.includes('[TASK]\nfix the bug'), true)
  assert.equal(payload.includes('[CONSTRAINTS]\n- (1) do not touch tests'), true)
  assert.equal(payload.includes('recent[#0] tool=bash error=true chars=12'), true)
  assert.equal(payload.includes('callId=c1'), true)
  assert.equal(DATA_BOUNDARY.includes('JSON'), true)
})

test('buildPlannerInstruction joins the policy prompt, data boundary and payload', () => {
  const instruction = buildPlannerInstruction({
    locale: 'zh',
    policy: 'conservative',
    task: 'task',
    candidates: [{ index: 0, tool: 'bash', isError: false, chars: 4096, callId: 'c1', text: 'x' }],
  })
  assert.equal(instruction.startsWith(SYSTEM_PROMPTS.zh.conservative), true)
  assert.equal(instruction.includes(DATA_BOUNDARY), true)
  assert.equal(instruction.includes('[CANDIDATES]'), true)
  assert.equal(renderRecent([]), '（无）')
})
