export function codexArgs(job, cwd, session, pointer) {
  const options = []
  if (job.targetModel) options.push('--model=' + job.targetModel)
  if (job.reasoningEffort) options.push('-c', 'model_reasoning_effort=' + JSON.stringify(job.reasoningEffort))
  return session
    ? ['resume', ...options, session, pointer, '-C', cwd]
    : [...options, '-C', cwd, pointer]
}

export function queueArgs(session, pointer) {
  return ['queue', '--thread', session, '--message', pointer, '--resume']
}
