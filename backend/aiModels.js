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

/** The request body for OpenRouter's chat completions. */
function providerBody({ model, effort, messages, max_tokens, temperature, extra = {} }) {
    const info = modelInfo(model);
    const thinks = Boolean(effort) && (info?.reasoning === 'required' || info?.reasoning === 'optional' || !info);
    const thinking = thinks ? (catalogue.thinkingTokens[effort] || 0) : 0;
    const body = {
        model,
        messages,
        max_tokens: Number(max_tokens) + thinking,
        ...(thinks ? { reasoning: { effort, exclude: true } } : {}),
        ...extra,
    };
    // Claude 5.5 models reject sampling settings; others accept them.
    if (info?.temperature !== false && temperature !== undefined) body.temperature = temperature;
    return body;
}

module.exports = { catalogue, EFFORTS, JOB_NAMES, jobConfig, jobModels, modelInfo, modelLabel, resolveModel, providerBody };
