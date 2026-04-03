import { describe, it, expect } from 'vitest';
import { isAllowedFetchProxyURL } from '../fetch-proxy-security';

describe('isAllowedFetchProxyURL', () => {
  describe('allowed URLs', () => {
    it('should allow localhost with any port', () => {
      expect(isAllowedFetchProxyURL('http://localhost:11434/api/chat')).toBe(true);
      expect(isAllowedFetchProxyURL('http://localhost:8080')).toBe(true);
      expect(isAllowedFetchProxyURL('http://localhost')).toBe(true);
    });

    it('should allow 127.0.0.1 with any port', () => {
      expect(isAllowedFetchProxyURL('http://127.0.0.1:1234/v1/completions')).toBe(true);
      expect(isAllowedFetchProxyURL('http://127.0.0.1')).toBe(true);
    });

    it('should allow IPv6 loopback ::1', () => {
      expect(isAllowedFetchProxyURL('http://[::1]:11434/api/chat')).toBe(true);
      expect(isAllowedFetchProxyURL('http://[::1]')).toBe(true);
    });

    it('should allow 0.0.0.0', () => {
      expect(isAllowedFetchProxyURL('http://0.0.0.0:11434')).toBe(true);
    });

    it('should allow host.docker.internal', () => {
      expect(isAllowedFetchProxyURL('http://host.docker.internal:11434')).toBe(true);
      expect(isAllowedFetchProxyURL('https://host.docker.internal:8080/v1/chat')).toBe(true);
    });

    it('should allow 10.x.x.x private range', () => {
      expect(isAllowedFetchProxyURL('http://10.0.0.1:8080')).toBe(true);
      expect(isAllowedFetchProxyURL('http://10.255.255.255:1234')).toBe(true);
    });

    it('should allow 172.16-31.x.x private range', () => {
      expect(isAllowedFetchProxyURL('http://172.16.0.1:8080')).toBe(true);
      expect(isAllowedFetchProxyURL('http://172.31.255.255:1234')).toBe(true);
    });

    it('should allow 192.168.x.x private range', () => {
      expect(isAllowedFetchProxyURL('http://192.168.1.100:8080')).toBe(true);
      expect(isAllowedFetchProxyURL('http://192.168.0.1')).toBe(true);
    });

    it('should allow https protocol', () => {
      expect(isAllowedFetchProxyURL('https://localhost:11434')).toBe(true);
      expect(isAllowedFetchProxyURL('https://192.168.1.1:443')).toBe(true);
    });
  });

  describe('blocked URLs', () => {
    it('should deny public internet URLs', () => {
      expect(isAllowedFetchProxyURL('https://api.openai.com/v1/chat')).toBe(false);
      expect(isAllowedFetchProxyURL('http://evil.com')).toBe(false);
      expect(isAllowedFetchProxyURL('https://google.com')).toBe(false);
    });

    it('should deny file:// protocol', () => {
      expect(isAllowedFetchProxyURL('file:///etc/passwd')).toBe(false);
    });

    it('should deny ftp:// protocol', () => {
      expect(isAllowedFetchProxyURL('ftp://localhost/file')).toBe(false);
    });

    it('should deny javascript: protocol', () => {
      expect(isAllowedFetchProxyURL('javascript:alert(1)')).toBe(false);
    });

    it('should deny public IPs', () => {
      expect(isAllowedFetchProxyURL('http://8.8.8.8')).toBe(false);
      expect(isAllowedFetchProxyURL('http://1.1.1.1')).toBe(false);
    });

    it('should deny 172.x outside 16-31 range', () => {
      expect(isAllowedFetchProxyURL('http://172.15.0.1:8080')).toBe(false);
      expect(isAllowedFetchProxyURL('http://172.32.0.1:8080')).toBe(false);
    });

    it('should deny invalid URLs', () => {
      expect(isAllowedFetchProxyURL('')).toBe(false);
      expect(isAllowedFetchProxyURL('not-a-url')).toBe(false);
      expect(isAllowedFetchProxyURL('://missing-protocol')).toBe(false);
    });
  });
});
