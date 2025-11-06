/**
 * GitHub Integration Service
 *
 * Handles all GitHub API interactions including:
 * - OAuth authentication
 * - Repository management
 * - File browsing
 * - Code search
 * - Content fetching
 */

import { encrypt, decrypt } from '../encryption-utils';

export interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string;
  name: string | null;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
}

export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  content?: string; // Base64 encoded
  encoding?: string;
}

export interface GitHubSearchResult {
  path: string;
  repository: {
    full_name: string;
    html_url: string;
  };
  score: number;
  text_matches?: {
    fragment: string;
    matches: {
      text: string;
      indices: [number, number];
    }[];
  }[];
}

export interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      email: string;
      date: string;
    };
  };
  html_url: string;
}

export interface GitHubBranch {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  protected: boolean;
}

export class GitHubService {
  private baseUrl = 'https://api.github.com';

  constructor(private accessToken: string) {}

  /**
   * Create GitHubService from encrypted token stored in database
   */
  static fromEncryptedToken(encryptedToken: string): GitHubService {
    const decryptedToken = decrypt(encryptedToken);
    return new GitHubService(decryptedToken);
  }

  /**
   * Encrypt access token for storage
   */
  static encryptToken(token: string): string {
    return encrypt(token);
  }

  /**
   * Get authenticated user information
   */
  async getAuthenticatedUser(): Promise<GitHubUser> {
    const response = await this.request<GitHubUser>('/user');
    return response;
  }

  /**
   * List repositories accessible to the authenticated user
   */
  async listRepositories(options: {
    visibility?: 'all' | 'public' | 'private';
    affiliation?: 'owner' | 'collaborator' | 'organization_member';
    sort?: 'created' | 'updated' | 'pushed' | 'full_name';
    direction?: 'asc' | 'desc';
    per_page?: number;
    page?: number;
  } = {}): Promise<GitHubRepository[]> {
    const params = new URLSearchParams({
      visibility: options.visibility || 'all',
      affiliation: options.affiliation || 'owner,collaborator,organization_member',
      sort: options.sort || 'updated',
      direction: options.direction || 'desc',
      per_page: (options.per_page || 100).toString(),
      page: (options.page || 1).toString(),
    });

    return this.request<GitHubRepository[]>(`/user/repos?${params}`);
  }

  /**
   * Get a specific repository
   */
  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(`/repos/${owner}/${repo}`);
  }

  /**
   * List branches for a repository
   */
  async listBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
    return this.request<GitHubBranch[]>(`/repos/${owner}/${repo}/branches`);
  }

  /**
   * Get contents of a file or directory
   */
  async getContents(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<GitHubFileContent | GitHubFileContent[]> {
    const params = new URLSearchParams();
    if (ref) params.set('ref', ref);

    const url = `/repos/${owner}/${repo}/contents/${path}${params.toString() ? '?' + params : ''}`;
    return this.request<GitHubFileContent | GitHubFileContent[]>(url);
  }

  /**
   * Get file content as decoded text
   */
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<{ content: string; sha: string; size: number }> {
    const result = await this.getContents(owner, repo, path, ref);

    if (Array.isArray(result)) {
      throw new Error('Path is a directory, not a file');
    }

    if (result.type !== 'file') {
      throw new Error(`Path is a ${result.type}, not a file`);
    }

    if (!result.content || !result.encoding) {
      throw new Error('File content not available');
    }

    if (result.encoding !== 'base64') {
      throw new Error(`Unsupported encoding: ${result.encoding}`);
    }

    // Decode base64 content
    const content = Buffer.from(result.content, 'base64').toString('utf-8');

    return {
      content,
      sha: result.sha,
      size: result.size,
    };
  }

  /**
   * Search code across repositories
   */
  async searchCode(
    query: string,
    options: {
      repo?: string; // owner/repo format
      language?: string;
      path?: string;
      per_page?: number;
      page?: number;
    } = {}
  ): Promise<{ items: GitHubSearchResult[]; total_count: number }> {
    let searchQuery = query;

    if (options.repo) searchQuery += ` repo:${options.repo}`;
    if (options.language) searchQuery += ` language:${options.language}`;
    if (options.path) searchQuery += ` path:${options.path}`;

    const params = new URLSearchParams({
      q: searchQuery,
      per_page: (options.per_page || 30).toString(),
      page: (options.page || 1).toString(),
    });

    return this.request<{ items: GitHubSearchResult[]; total_count: number }>(
      `/search/code?${params}`,
      {
        headers: {
          Accept: 'application/vnd.github.v3.text-match+json', // Include text matches
        },
      }
    );
  }

  /**
   * Get commit information
   */
  async getCommit(owner: string, repo: string, sha: string): Promise<GitHubCommit> {
    return this.request<GitHubCommit>(`/repos/${owner}/${repo}/commits/${sha}`);
  }

  /**
   * List commits for a repository
   */
  async listCommits(
    owner: string,
    repo: string,
    options: {
      sha?: string; // Branch or commit SHA
      path?: string;
      per_page?: number;
      page?: number;
    } = {}
  ): Promise<GitHubCommit[]> {
    const params = new URLSearchParams({
      per_page: (options.per_page || 30).toString(),
      page: (options.page || 1).toString(),
    });

    if (options.sha) params.set('sha', options.sha);
    if (options.path) params.set('path', options.path);

    return this.request<GitHubCommit[]>(`/repos/${owner}/${repo}/commits?${params}`);
  }

  /**
   * Check if token has specific scopes
   */
  async checkScopes(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/user`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    const scopes = response.headers.get('X-OAuth-Scopes');
    return scopes ? scopes.split(',').map(s => s.trim()) : [];
  }

  /**
   * Validate that the access token is valid
   */
  async validateToken(): Promise<boolean> {
    try {
      await this.getAuthenticatedUser();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Generic request method with error handling
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage = `GitHub API error: ${response.status} ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage = errorJson.message || errorMessage;
      } catch {
        // If parsing fails, use the default error message
      }

      throw new Error(errorMessage);
    }

    // Check for rate limiting
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const reset = response.headers.get('X-RateLimit-Reset');

    if (remaining && parseInt(remaining) < 10) {
      console.warn(`GitHub API rate limit low: ${remaining} requests remaining. Resets at ${reset}`);
    }

    return response.json();
  }
}

/**
 * GitHub OAuth utilities
 */
export class GitHubOAuth {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
  }

  /**
   * Get OAuth authorization URL
   */
  getAuthorizationUrl(state: string, scopes: string[] = ['repo', 'read:user', 'user:email']): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: scopes.join(' '),
      state,
    });

    return `https://github.com/login/oauth/authorize?${params}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<{
    access_token: string;
    token_type: string;
    scope: string;
  }> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.redirectUri,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to exchange code for token: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
    }

    return data;
  }
}

/**
 * Detect programming language from file extension
 */
export function detectLanguageFromPath(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    md: 'markdown',
    txt: 'text',
  };

  return ext ? languageMap[ext] || null : null;
}
