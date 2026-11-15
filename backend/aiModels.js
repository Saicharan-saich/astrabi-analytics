'use strict';

/**
 * Which AI model does which job (see aiModels.json), and how a request is
 * shaped for it.
 *
 * Claude 5.5 models on OpenRouter always think before answering: they refuse
 * `temperature`, and the thinking shares `max_tokens` with the reply. So the
 * reply budget a caller asks for is kept for the reply, and a thinking
 * allowance for the job's effort is added on top. Thinking text is not
 * returned, only the answer.
 */

const catalogue = require('./aiModels.json');

const EFFORTS = ['low', 'medium', 'high'];
const JOB_NAMES = Object.keys(catalogue.jobs);

const envName = (job) => job.replace(/^qi:/, '').toUpperCase();

/** The model and effort for a job, with any server override applied. */
function jobConfig(job, env = process.env) {
    const base = catalogue.jobs[job];
    if (!base) return null;
    const model = String(env[`AI_MODEL_${envName(job)}`] || base.model).trim();
    const effortSetting = String(env[`AI_EFFORT_${envName(job)}`] || base.effort).trim().toLowerCase();
    return { job, model, effort: EFFORTS.includes(effortSetting) ? effortSetting : base.effort };
}

function modelInfo(model) {
    return catalogue.models[model] || null;
}

function modelLabel(model) {
    return modelInfo(model)?.label || model;
}

/** Every real model the jobs can use (after overrides). */
function jobModels(env = process.env) {
    return JOB_NAMES.map(job => jobConfig(job, env).model);
}

/**
 * Turn a job name or model into what is sent to OpenRouter.
 * `requestedEffort` lets a caller ask for more or less thinking for one call.
 */
function resolveModel(requested, requestedEffort, env = process.env) {
    const job = jobConfig(requested, env);
    if (job) {
        const effort = EFFORTS.includes(requestedEffort) ? requestedEffort : job.effort;
        return { model: job.model, effort, job: job.job };
    }
    const info = modelInfo(requested);
    const effort = EFFORTS.includes(requestedEffort) ? requestedEffort : (info?.reasoning ? 'medium' : null);
    return { model: requested, effort, job: null };
}

const cacheMark = (ttl) => (ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });

/** Split "column description … QUESTION …" so the description can be cached on its own. */
function splitForCache(text, headings) {
    let at = -1;
    for (const heading of headings) {
        const match = text.match(new RegExp(`(^|\\n)${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
        if (match && match.index > 0 && (at < 0 || match.index < at)) at = match.index;
    }
    return at > 0 ? [text.slice(0, at), text.slice(at)] : null;
}

/**
 * Mark the parts of a request that repeat (instructions, then the description
 * of the user's columns) as cacheable. Only for models with "cache": true.
 * The text sent is unchanged; it is only divided into blocks.
 */
function withCaching(model, messages, env = process.env) {
    const info = modelInfo(model);
    const config = catalogue.caching;
    // AI_PROMPT_CACHE=off sends requests without cache marks.
    if (/^(off|false|0|no)$/i.test(String(env.AI_PROMPT_CACHE || '').trim())) return messages;
    if (!info?.cache || !config || !Array.isArray(messages)) return messages;
    let firstUserDone = false;
    return messages.map((message) => {
        if (message.role === 'system') {
            if (typeof message.content === 'string') {
                return { ...message, content: [{ type: 'text', text: message.content, cache_control: cacheMark(config.systemTtl) }] };
            }
            if (Array.isArray(message.content) && message.content[0]?.type === 'text') {
                return { ...message, content: message.content.map((part, i) => (i === 0 ? { ...part, cache_control: cacheMark(config.systemTtl) } : part)) };
            }
            return message;
        }
        if (message.role === 'user' && !firstUserDone && typeof message.content === 'string') {
            firstUserDone = true;
            const parts = splitForCache(message.content, config.splitBefore || []);
            if (!parts) return message;
            return { ...message, content: [
                { type: 'text', text: parts[0], cache_control: cacheMark(config.dataTtl) },
                { type: 'text', text: parts[1] },
            ] };
        }
        if (message.role === 'user') firstUserDone = true;
        return message;
    });
}

/** The request body for OpenRouter's chat completions. */
function providerBody({ model, effort, messages, max_tokens, temperature, extra = {} }) {
    const info = modelInfo(model);
    const thinks = Boolean(effort) && (info?.reasoning === 'required' || info?.reasoning === 'optional' || !info);
    const thinking = thinks ? (catalogue.thinkingTokens[effort] || 0) : 0;
    const body = {
        model,
        messages: withCaching(model, messages),
        max_tokens: Number(max_tokens) + thinking,
        ...(thinks ? { reasoning: { effort, exclude: true } } : {}),
        ...extra,
    };
    // Claude 5.5 models reject sampling settings; others accept them.
    if (info?.temperature !== false && temperature !== undefined) body.temperature = temperature;
    return body;
}

module.exports = { catalogue, EFFORTS, JOB_NAMES, jobConfig, jobModels, modelInfo, modelLabel, resolveModel, providerBody, withCaching, splitForCache };
