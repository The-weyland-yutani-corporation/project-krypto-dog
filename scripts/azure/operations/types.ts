export type AzureOperationContext = {
  environmentName: string;
  releaseSha: string;
  jobExecutionId: string;
  /** Immutable local directory derived from environmentName/releaseSha/operation/jobExecutionId. */
  reportDirectory: string;
};

export type AzureOperationResult = {
  passed: boolean;
  report: unknown;
};
