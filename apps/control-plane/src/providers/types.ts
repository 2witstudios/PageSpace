export type InfraExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type TenantInfraProvider = {
  /** Bring up tenant infrastructure from env content */
  provision(slug: string, envContent: string): Promise<void>
  /** Tear down tenant infrastructure, optionally backing up first */
  destroy(slug: string, opts?: { backup?: boolean }): Promise<void>
  /** Stop application services (keep data stores running) */
  suspend(slug: string): Promise<void>
  /** Start previously stopped application services */
  resume(slug: string): Promise<void>
  /** Update running services to a new image version */
  upgrade(slug: string, imageTag: string): Promise<void>
  /** Check if tenant services are healthy */
  healthCheck(slug: string): Promise<{ healthy: boolean }>
  /** Execute a command inside the tenant's environment */
  exec(slug: string, command: string): Promise<InfraExecResult>
}
