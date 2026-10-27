import { describe, it } from 'vitest';
import { assert } from './riteway';
import {
  askUserTools,
  askUserInputSchema,
  askUserOutputSchema,
  ASK_USER_TOOL_NAME,
} from '../ask-user-tools';

const question = (overrides: Partial<{ header: string; question: string; options: Array<{ label: string; description?: string }> }> = {}) => ({
  header: 'Auth method',
  question: 'Which auth method should we use?',
  options: [{ label: 'OAuth' }, { label: 'API key' }],
  ...overrides,
});

describe('ask_user tool definition', () => {
  it('has no execute — it is a client-side tool that pauses the turn', () => {
    assert({
      given: 'the ask_user tool definition',
      should: 'not have an execute function',
      actual: 'execute' in askUserTools[ASK_USER_TOOL_NAME],
      expected: false,
    });
  });
});

describe('askUserInputSchema', () => {
  it('accepts 1-4 questions with 2-4 options each', () => {
    assert({
      given: 'a single well-formed question with two options',
      should: 'parse successfully',
      actual: askUserInputSchema.safeParse({ questions: [question()] }).success,
      expected: true,
    });
  });

  it('rejects zero questions', () => {
    assert({
      given: 'an empty questions array',
      should: 'fail validation',
      actual: askUserInputSchema.safeParse({ questions: [] }).success,
      expected: false,
    });
  });

  it('rejects more than 4 questions', () => {
    assert({
      given: 'five questions',
      should: 'fail validation',
      actual: askUserInputSchema.safeParse({ questions: Array.from({ length: 5 }, () => question()) }).success,
      expected: false,
    });
  });

  it('rejects a question with only one option', () => {
    assert({
      given: 'a question with a single option',
      should: 'fail validation',
      actual: askUserInputSchema.safeParse({
        questions: [question({ options: [{ label: 'Only one' }] })],
      }).success,
      expected: false,
    });
  });

  it('rejects a question with more than 4 options', () => {
    assert({
      given: 'a question with five options',
      should: 'fail validation',
      actual: askUserInputSchema.safeParse({
        questions: [question({ options: Array.from({ length: 5 }, (_, i) => ({ label: `Option ${i}` })) })],
      }).success,
      expected: false,
    });
  });
});

describe('askUserOutputSchema', () => {
  it('accepts a single answered question with a selected label', () => {
    assert({
      given: 'answers with a selectedLabel',
      should: 'parse successfully',
      actual: askUserOutputSchema.safeParse({
        answers: [{ header: 'Auth method', question: 'Which?', selectedLabel: 'OAuth' }],
      }).success,
      expected: true,
    });
  });

  it('accepts an answer with free-text otherText instead of a selection', () => {
    assert({
      given: 'answers with otherText only',
      should: 'parse successfully',
      actual: askUserOutputSchema.safeParse({
        answers: [{ header: 'Auth method', question: 'Which?', otherText: 'Something else' }],
      }).success,
      expected: true,
    });
  });

  it('rejects an answer with neither selectedLabel nor otherText', () => {
    assert({
      given: 'an answer missing both selectedLabel and otherText',
      should: 'fail validation',
      actual: askUserOutputSchema.safeParse({
        answers: [{ header: 'Auth method', question: 'Which?' }],
      }).success,
      expected: false,
    });
  });

  it('accepts a dismissed output', () => {
    assert({
      given: 'a dismissed result (user answered in chat instead)',
      should: 'parse successfully',
      actual: askUserOutputSchema.safeParse({
        dismissed: true,
        reason: 'User replied in chat instead of selecting an option.',
      }).success,
      expected: true,
    });
  });

  it('rejects a bare object with neither answers nor dismissed', () => {
    assert({
      given: 'junk output matching neither union member',
      should: 'fail validation',
      actual: askUserOutputSchema.safeParse({ foo: 'bar' }).success,
      expected: false,
    });
  });
});
