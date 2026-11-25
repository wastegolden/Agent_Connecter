export function claudeArgs(job, session, pointer) {
  const args = []
  if (job.targetModel) args.push('--model', job.targetModel)
  if (job.reasoningEffort) args.push('--effort', job.reasoningEffort)
  if (session) args.push('--resume', session)
  return [...args, pointer]
}
