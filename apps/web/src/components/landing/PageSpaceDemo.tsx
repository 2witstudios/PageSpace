"use client";

import React from 'react';

export default function PageSpaceDemo() {
  return (
    <div className="w-full max-w-7xl mx-auto px-4">
      <svg
        viewBox="0 0 1400 800"
        className="w-full h-auto"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Gradients and filters for liquid glass effect */}
          <filter id="glass-blur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="0.5" />
          </filter>

          <linearGradient id="bg-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="oklch(0.995 0.002 240)" />
            <stop offset="100%" stopColor="oklch(0.94 0.003 230)" />
          </linearGradient>

          <filter id="soft-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="4" />
            <feOffset dx="0" dy="2" result="offsetblur" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.12" />
            </feComponentTransfer>
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Background */}
        <rect width="1400" height="800" fill="url(#bg-gradient)" />

        {/* Main container */}
        <g transform="translate(20, 20)">

          {/* Left Sidebar */}
          <g id="left-sidebar">
            {/* Sidebar background with liquid glass effect */}
            <rect
              x="0"
              y="0"
              width="280"
              height="760"
              rx="12"
              fill="oklch(0.98 0.003 230 / 0.92)"
              stroke="oklch(0.90 0.005 230 / 0.08)"
              strokeWidth="1"
              filter="url(#soft-shadow)"
            />

            {/* Drive Switcher */}
            <g transform="translate(12, 12)">
              <rect
                x="0"
                y="0"
                width="256"
                height="44"
                rx="8"
                fill="oklch(0.985 0.003 230)"
                stroke="oklch(0.90 0.005 230)"
                strokeWidth="1"
              />
              <text
                x="16"
                y="28"
                fontFamily="system-ui, -apple-system, sans-serif"
                fontSize="14"
                fontWeight="500"
                fill="oklch(0.15 0.01 220)"
              >
                PageSpace Drive
              </text>
              {/* ChevronDown icon */}
              <path
                d="M 232 22 L 236 26 L 240 22"
                stroke="oklch(0.48 0.015 220)"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>

            {/* Search Bar */}
            <g transform="translate(12, 72)">
              <rect
                x="0"
                y="0"
                width="208"
                height="36"
                rx="6"
                fill="oklch(0.985 0.003 230)"
                stroke="oklch(0.90 0.005 230)"
                strokeWidth="1"
              />
              {/* Lucide Search icon */}
              <circle
                cx="14"
                cy="18"
                r="6"
                stroke="oklch(0.48 0.015 220)"
                strokeWidth="2"
                fill="none"
              />
              <path
                d="M 18.5 21.5 L 23 26"
                stroke="oklch(0.48 0.015 220)"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <text
                x="32"
                y="23"
                fontFamily="system-ui, -apple-system, sans-serif"
                fontSize="13"
                fill="oklch(0.48 0.015 220)"
              >
                Search pages...
              </text>

              {/* Plus button */}
              <rect
                x="220"
                y="0"
                width="36"
                height="36"
                rx="6"
                fill="transparent"
                stroke="oklch(0.90 0.005 230)"
                strokeWidth="1"
              />
              {/* Lucide Plus icon */}
              <path
                d="M 238 12 L 238 24 M 232 18 L 244 18"
                stroke="oklch(0.15 0.01 220)"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </g>

            {/* Page Tree */}
            <g transform="translate(12, 128)">
              {/* Folder: Documentation (expanded) */}
              <g className="tree-item">
                {/* Lucide ChevronRight (rotated down) */}
                <path
                  d="M 6 8 L 10 12 L 6 16"
                  stroke="oklch(0.48 0.015 220)"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  transform="rotate(90 8 12)"
                />
                {/* Lucide Folder icon */}
                <path
                  d="M 18 8 L 18 18 L 30 18 L 30 10 L 26 10 L 24 8 Z"
                  fill="none"
                  stroke="oklch(0.50 0.16 235)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M 18 8 L 24 8"
                  stroke="oklch(0.50 0.16 235)"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <text
                  x="38"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fontWeight="500"
                  fill="oklch(0.15 0.01 220)"
                >
                  Documentation
                </text>
              </g>

              {/* Nested: Welcome to PageSpace (Document - Initially ACTIVE) */}
              <g transform="translate(20, 32)" className="tree-item">
                {/* Lucide FileText icon */}
                <path
                  d="M 18 6 L 18 20 L 28 20 L 28 10 L 24 6 Z M 24 6 L 24 10 L 28 10"
                  fill="none"
                  stroke="oklch(0.48 0.015 220)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <line x1="20" y1="13" x2="26" y2="13" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="20" y1="16" x2="26" y2="16" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" strokeLinecap="round" />
                <text
                  x="36"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fill="oklch(0.15 0.01 220)"
                >
                  Welcome to PageSpace
                </text>
                {/* Active indicator - fades out */}
                <rect
                  x="-8"
                  y="2"
                  width="3"
                  height="20"
                  rx="1.5"
                  fill="oklch(0.50 0.16 235)"
                >
                  <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.27;0.33;1" dur="18s" repeatCount="indefinite" />
                </rect>
              </g>

              {/* Nested: Getting Started (Document - appears and becomes active) */}
              <g transform="translate(20, 64)" className="tree-item" opacity="0">
                {/* Lucide FileText icon */}
                <path
                  d="M 18 6 L 18 20 L 28 20 L 28 10 L 24 6 Z M 24 6 L 24 10 L 28 10"
                  fill="none"
                  stroke="oklch(0.48 0.015 220)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <line x1="20" y1="13" x2="26" y2="13" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="20" y1="16" x2="26" y2="16" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" strokeLinecap="round" />
                <text
                  x="36"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fill="oklch(0.15 0.01 220)"
                >
                  Getting Started
                </text>
                {/* Active indicator - appears */}
                <rect
                  x="-8"
                  y="2"
                  width="3"
                  height="20"
                  rx="1.5"
                  fill="oklch(0.50 0.16 235)"
                  opacity="0"
                >
                  <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.27;0.33;0.94;1" dur="18s" repeatCount="indefinite" />
                </rect>
                {/* Entire item appears */}
                <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.16;0.22;0.94;1" dur="18s" repeatCount="indefinite" />
              </g>

              {/* Folder: Development (collapsed) */}
              <g transform="translate(0, 72)" className="tree-item">
                {/* Lucide ChevronRight */}
                <path
                  d="M 6 8 L 10 12 L 6 16"
                  stroke="oklch(0.48 0.015 220)"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* Lucide Folder icon */}
                <path
                  d="M 18 8 L 18 18 L 30 18 L 30 10 L 26 10 L 24 8 Z"
                  fill="none"
                  stroke="oklch(0.50 0.16 235)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M 18 8 L 24 8"
                  stroke="oklch(0.50 0.16 235)"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <text
                  x="38"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fontWeight="500"
                  fill="oklch(0.15 0.01 220)"
                >
                  Development
                </text>
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values="0 72; 0 72; 0 104; 0 104; 0 72"
                  keyTimes="0; 0.16; 0.22; 0.94; 1"
                  dur="18s"
                  repeatCount="indefinite"
                />
              </g>

              {/* Feature Roadmap (Document) */}
              <g transform="translate(0, 104)" className="tree-item">
                {/* Lucide FileText icon */}
                <path
                  d="M 18 6 L 18 20 L 28 20 L 28 10 L 24 6 Z M 24 6 L 24 10 L 28 10"
                  fill="none"
                  stroke="oklch(0.48 0.015 220)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <line x1="20" y1="13" x2="26" y2="13" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="20" y1="16" x2="26" y2="16" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" strokeLinecap="round" />
                <text
                  x="36"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fill="oklch(0.15 0.01 220)"
                >
                  Feature Roadmap
                </text>
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values="0 104; 0 104; 0 136; 0 136; 0 104"
                  keyTimes="0; 0.16; 0.22; 0.94; 1"
                  dur="18s"
                  repeatCount="indefinite"
                />
              </g>

              {/* Team Discussion (Channel) */}
              <g transform="translate(0, 136)" className="tree-item">
                {/* Lucide MessageSquare icon */}
                <path
                  d="M 17 8 L 29 8 L 29 18 L 25 18 L 21 22 L 21 18 L 17 18 Z"
                  fill="none"
                  stroke="oklch(0.48 0.015 220)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <text
                  x="38"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fill="oklch(0.15 0.01 220)"
                >
                  Team Discussion
                </text>
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values="0 136; 0 136; 0 168; 0 168; 0 136"
                  keyTimes="0; 0.16; 0.22; 0.94; 1"
                  dur="18s"
                  repeatCount="indefinite"
                />
              </g>

              {/* AI Assistant (AI Chat) */}
              <g transform="translate(0, 168)" className="tree-item">
                {/* Lucide Sparkles icon */}
                <path
                  d="M 23 4 L 23.5 8 L 27.5 8.5 L 23.5 9 L 23 13 L 22.5 9 L 18.5 8.5 L 22.5 8 Z"
                  fill="oklch(0.48 0.015 220)"
                  stroke="oklch(0.48 0.015 220)"
                  strokeWidth="1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="28" cy="6" r="1.5" fill="oklch(0.48 0.015 220)" />
                <circle cx="19" cy="13" r="1" fill="oklch(0.48 0.015 220)" />
                <text
                  x="38"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fill="oklch(0.15 0.01 220)"
                >
                  AI Assistant
                </text>
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values="0 168; 0 168; 0 200; 0 200; 0 168"
                  keyTimes="0; 0.16; 0.22; 0.94; 1"
                  dur="18s"
                  repeatCount="indefinite"
                />
              </g>

              {/* Resources Folder (collapsed) */}
              <g transform="translate(0, 200)" className="tree-item">
                {/* Lucide ChevronRight */}
                <path
                  d="M 6 8 L 10 12 L 6 16"
                  stroke="oklch(0.48 0.015 220)"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* Lucide Folder icon */}
                <path
                  d="M 18 8 L 18 18 L 30 18 L 30 10 L 26 10 L 24 8 Z"
                  fill="none"
                  stroke="oklch(0.50 0.16 235)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M 18 8 L 24 8"
                  stroke="oklch(0.50 0.16 235)"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <text
                  x="38"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fontWeight="500"
                  fill="oklch(0.15 0.01 220)"
                >
                  Resources
                </text>
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values="0 200; 0 200; 0 232; 0 232; 0 200"
                  keyTimes="0; 0.16; 0.22; 0.94; 1"
                  dur="18s"
                  repeatCount="indefinite"
                />
              </g>
            </g>

            {/* Bottom Navigation */}
            <g transform="translate(12, 690)">
              {/* Members */}
              <g className="nav-item">
                <rect x="0" y="0" width="256" height="32" rx="6" fill="transparent" />
                {/* Lucide Users icon */}
                <circle cx="16" cy="14" r="4" fill="none" stroke="oklch(0.48 0.015 220)" strokeWidth="2" />
                <circle cx="26" cy="14" r="4" fill="none" stroke="oklch(0.48 0.015 220)" strokeWidth="2" />
                <path d="M 9 26 C 9 22 12 20 16 20 C 20 20 23 22 23 26" fill="none" stroke="oklch(0.48 0.015 220)" strokeWidth="2" strokeLinecap="round" />
                <path d="M 19 26 C 19 22 22 20 26 20 C 30 20 33 22 33 26" fill="none" stroke="oklch(0.48 0.015 220)" strokeWidth="2" strokeLinecap="round" />
                <text
                  x="42"
                  y="21"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fill="oklch(0.15 0.01 220)"
                >
                  Members
                </text>
              </g>

              {/* Trash */}
              <g transform="translate(0, 36)" className="nav-item">
                <rect x="0" y="0" width="256" height="32" rx="6" fill="transparent" />
                {/* Lucide Trash2 icon */}
                <path d="M 13 10 L 13 22 L 23 22 L 23 10" fill="none" stroke="oklch(0.48 0.015 220)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M 11 10 L 25 10" stroke="oklch(0.48 0.015 220)" strokeWidth="2" strokeLinecap="round" />
                <path d="M 15 10 L 15 8 L 21 8 L 21 10" stroke="oklch(0.48 0.015 220)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="16" y1="14" x2="16" y2="19" stroke="oklch(0.48 0.015 220)" strokeWidth="2" strokeLinecap="round" />
                <line x1="20" y1="14" x2="20" y2="19" stroke="oklch(0.48 0.015 220)" strokeWidth="2" strokeLinecap="round" />
                <text
                  x="42"
                  y="21"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fill="oklch(0.15 0.01 220)"
                >
                  Trash
                </text>
              </g>
            </g>
          </g>

          {/* Center Panel */}
          <g id="center-panel" transform="translate(300, 0)">
            {/* Panel background */}
            <rect
              x="0"
              y="0"
              width="780"
              height="760"
              rx="12"
              fill="oklch(0.995 0.002 240)"
              stroke="oklch(0.90 0.005 230 / 0.08)"
              strokeWidth="1"
              filter="url(#soft-shadow)"
            />

            {/* Header */}
            <g transform="translate(24, 20)">
              {/* Breadcrumbs - initial */}
              <g opacity="1">
                <text
                  x="0"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fill="oklch(0.48 0.015 220)"
                >
                  <tspan>Documentation / </tspan>
                  <tspan fontWeight="500" fill="oklch(0.15 0.01 220)">Welcome to PageSpace</tspan>
                </text>
                <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.27;0.33;1" dur="18s" repeatCount="indefinite" />
              </g>
              {/* Breadcrumbs - updated */}
              <g opacity="0">
                <text
                  x="0"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="13"
                  fill="oklch(0.48 0.015 220)"
                >
                  <tspan>Documentation / </tspan>
                  <tspan fontWeight="500" fill="oklch(0.15 0.01 220)">Getting Started</tspan>
                </text>
                <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.33;0.39;0.94;1" dur="18s" repeatCount="indefinite" />
              </g>

              {/* Save indicator */}
              <g transform="translate(650, 0)">
                {/* Saving state (active during update) */}
                <circle cx="8" cy="12" r="3" fill="oklch(0.55 0.20 35)" opacity="0">
                  <animate
                    attributeName="opacity"
                    values="0;0;0.8;0.3;0.8;0"
                    keyTimes="0;0.33;0.39;0.44;0.50;0.55"
                    dur="18s"
                    repeatCount="indefinite"
                  />
                </circle>
                <text
                  x="18"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="12"
                  fill="oklch(0.48 0.015 220)"
                  opacity="0"
                >
                  Saving...
                  <animate
                    attributeName="opacity"
                    values="0;0;1;1;0"
                    keyTimes="0;0.33;0.39;0.50;0.55"
                    dur="18s"
                    repeatCount="indefinite"
                  />
                </text>
                {/* Saved state */}
                <circle cx="8" cy="12" r="3" fill="oklch(0.6 0.25 90)" opacity="0.3">
                  <animate
                    attributeName="opacity"
                    values="0.3;0.3;0;0;0.8;0.3"
                    keyTimes="0;0.33;0.39;0.50;0.55;1"
                    dur="18s"
                    repeatCount="indefinite"
                  />
                </circle>
                <text
                  x="18"
                  y="16"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="12"
                  fill="oklch(0.48 0.015 220)"
                  opacity="1"
                >
                  Saved
                  <animate
                    attributeName="opacity"
                    values="1;1;0;0;1"
                    keyTimes="0;0.33;0.39;0.50;1"
                    dur="18s"
                    repeatCount="indefinite"
                  />
                </text>
              </g>

              {/* Editor toggles */}
              <g transform="translate(0, 40)">
                <rect
                  x="0"
                  y="0"
                  width="56"
                  height="28"
                  rx="6"
                  fill="oklch(0.50 0.16 235)"
                />
                <text
                  x="28"
                  y="18"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="12"
                  fontWeight="500"
                  fill="oklch(0.98 0.005 235)"
                  textAnchor="middle"
                >
                  Rich
                </text>
                <rect
                  x="64"
                  y="0"
                  width="56"
                  height="28"
                  rx="6"
                  fill="transparent"
                  stroke="oklch(0.90 0.005 230)"
                  strokeWidth="1"
                />
                <text
                  x="76"
                  y="18"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="12"
                  fill="oklch(0.48 0.015 220)"
                >
                  Code
                </text>
              </g>
            </g>

            {/* Toolbar */}
            <g transform="translate(24, 110)">
              <rect
                x="0"
                y="0"
                width="732"
                height="48"
                rx="8"
                fill="oklch(0.985 0.003 230 / 0.92)"
                stroke="oklch(0.90 0.005 230)"
                strokeWidth="1"
              />

              {/* Toolbar buttons */}
              <g transform="translate(12, 12)">
                {/* Bold */}
                <rect x="0" y="0" width="32" height="24" rx="4" fill="transparent" />
                <text x="10" y="17" fontFamily="system-ui" fontSize="14" fontWeight="700" fill="oklch(0.15 0.01 220)">B</text>

                {/* Italic */}
                <rect x="40" y="0" width="32" height="24" rx="4" fill="transparent" />
                <text x="52" y="17" fontFamily="serif" fontSize="14" fontStyle="italic" fill="oklch(0.15 0.01 220)">I</text>

                {/* Underline */}
                <rect x="80" y="0" width="32" height="24" rx="4" fill="transparent" />
                <text x="90" y="17" fontFamily="system-ui" fontSize="14" textDecoration="underline" fill="oklch(0.15 0.01 220)">U</text>

                {/* Separator */}
                <line x1="120" y1="4" x2="120" y2="20" stroke="oklch(0.90 0.005 230)" strokeWidth="1" />

                {/* Heading */}
                <rect x="130" y="0" width="36" height="24" rx="4" fill="transparent" />
                <text x="138" y="17" fontFamily="system-ui" fontSize="13" fontWeight="600" fill="oklch(0.15 0.01 220)">H1</text>

                {/* List */}
                <rect x="176" y="0" width="32" height="24" rx="4" fill="transparent" />
                <circle cx="188" cy="8" r="2" fill="oklch(0.15 0.01 220)" />
                <line x1="194" y1="8" x2="202" y2="8" stroke="oklch(0.15 0.01 220)" strokeWidth="1.5" />
                <circle cx="188" cy="16" r="2" fill="oklch(0.15 0.01 220)" />
                <line x1="194" y1="16" x2="202" y2="16" stroke="oklch(0.15 0.01 220)" strokeWidth="1.5" />
              </g>
            </g>

            {/* Editor Content */}
            <g transform="translate(100, 190)">
              {/* Initial Title - fades out */}
              <text
                x="0"
                y="32"
                fontFamily="system-ui, -apple-system, sans-serif"
                fontSize="32"
                fontWeight="700"
                fill="oklch(0.15 0.01 220)"
              >
                Welcome to PageSpace
                <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.27;0.33;1" dur="18s" repeatCount="indefinite" />
              </text>

              {/* New Title - fades in */}
              <text
                x="0"
                y="32"
                fontFamily="system-ui, -apple-system, sans-serif"
                fontSize="32"
                fontWeight="700"
                fill="oklch(0.15 0.01 220)"
                opacity="0"
              >
                Getting Started
                <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.33;0.39;0.94;1" dur="18s" repeatCount="indefinite" />
              </text>

              {/* Initial Content - fades out */}
              <g opacity="1">
                <text
                  x="0"
                  y="80"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="15"
                  fill="oklch(0.15 0.01 220)"
                >
                  <tspan x="0" dy="0">Welcome to PageSpace! This is your all-in-one workspace for organizing</tspan>
                  <tspan x="0" dy="24">knowledge, collaborating with your team, and building with AI.</tspan>
                </text>

                <text
                  x="0"
                  y="144"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="20"
                  fontWeight="600"
                  fill="oklch(0.15 0.01 220)"
                >
                  Key Features
                </text>

                <g transform="translate(0, 168)">
                  <circle cx="8" cy="8" r="3" fill="oklch(0.50 0.16 235)" />
                  <text x="24" y="13" fontFamily="system-ui" fontSize="15" fill="oklch(0.15 0.01 220)">
                    Hierarchical organization - everything is a page
                  </text>

                  <circle cx="8" cy="40" r="3" fill="oklch(0.50 0.16 235)" />
                  <text x="24" y="45" fontFamily="system-ui" fontSize="15" fill="oklch(0.15 0.01 220)">
                    Real-time collaboration with your team
                  </text>

                  <circle cx="8" cy="72" r="3" fill="oklch(0.50 0.16 235)" />
                  <text x="24" y="77" fontFamily="system-ui" fontSize="15" fill="oklch(0.15 0.01 220)">
                    AI-powered assistance built right in
                  </text>
                </g>
                <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.27;0.33;1" dur="18s" repeatCount="indefinite" />
              </g>

              {/* New Content - fades in with typing effect */}
              <g opacity="0">
                <text
                  x="0"
                  y="80"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="15"
                  fill="oklch(0.15 0.01 220)"
                >
                  <tspan x="0" dy="0">Welcome! This guide will help you get started with PageSpace and</tspan>
                  <tspan x="0" dy="24">learn the essential features for organizing your workspace.</tspan>
                </text>

                <text
                  x="0"
                  y="144"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontSize="20"
                  fontWeight="600"
                  fill="oklch(0.15 0.01 220)"
                >
                  Quick Start
                </text>

                <g transform="translate(0, 168)">
                  <circle cx="8" cy="8" r="3" fill="oklch(0.50 0.16 235)" />
                  <text x="24" y="13" fontFamily="system-ui" fontSize="15" fill="oklch(0.15 0.01 220)">
                    Ask your AI assistant about the project you&apos;re working on
                  </text>

                  <circle cx="8" cy="40" r="3" fill="oklch(0.50 0.16 235)" />
                  <text x="24" y="45" fontFamily="system-ui" fontSize="15" fill="oklch(0.15 0.01 220)">
                    Have it create the workspace structure that best fits your project
                  </text>

                  <circle cx="8" cy="72" r="3" fill="oklch(0.50 0.16 235)" />
                  <text x="24" y="77" fontFamily="system-ui" fontSize="15" fill="oklch(0.15 0.01 220)">
                    Collaborate with your AI assistant and other people!
                  </text>
                </g>
                <animate attributeName="opacity" values="0;0;0;1;1;0" keyTimes="0;0.33;0.44;0.50;0.94;1" dur="18s" repeatCount="indefinite" />
              </g>

              {/* Blinking cursor - moves with content */}
              <rect
                x="0"
                y="344"
                width="2"
                height="20"
                fill="oklch(0.50 0.16 235)"
              >
                <animate
                  attributeName="opacity"
                  values="1;0;1"
                  dur="1s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="y"
                  values="344;344;280;280;344"
                  keyTimes="0;0.33;0.50;0.94;1"
                  dur="18s"
                  repeatCount="indefinite"
                />
              </rect>
            </g>
          </g>

          {/* Right Panel - AI Assistant */}
          <g id="right-panel" transform="translate(1100, 0)">
            <rect
              x="0"
              y="0"
              width="260"
              height="760"
              rx="12"
              fill="oklch(0.98 0.003 230 / 0.92)"
              stroke="oklch(0.90 0.005 230 / 0.08)"
              strokeWidth="1"
              filter="url(#soft-shadow)"
            />

            {/* Tab Bar */}
            <g transform="translate(0, 0)">
              <rect x="0" y="0" width="260" height="52" fill="transparent" />
              <line x1="0" y1="52" x2="260" y2="52" stroke="oklch(0.90 0.005 230 / 0.08)" strokeWidth="1" />

              {/* Tabs */}
              <g transform="translate(8, 4)">
                {/* Chat tab (active) */}
                <rect x="0" y="0" width="76" height="40" rx="6" fill="oklch(0.995 0.002 240)" />
                <rect x="18" y="38" width="40" height="2" rx="1" fill="oklch(0.50 0.16 235)" />
                {/* MessageSquare icon */}
                <path
                  d="M 20 14 L 28 14 L 28 22 L 25 22 L 22 25 L 22 22 L 20 22 Z"
                  fill="none"
                  stroke="oklch(0.15 0.01 220)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <text x="34" y="23" fontFamily="system-ui" fontSize="11" fontWeight="500" fill="oklch(0.15 0.01 220)">Chat</text>

                {/* History tab */}
                <rect x="78" y="0" width="76" height="40" rx="6" fill="transparent" />
                {/* History icon */}
                <circle cx="116" cy="20" r="6" fill="none" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" />
                <path d="M 116 16 L 116 20 L 119 20" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M 113 15 L 111 13 L 113 11" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                <text x="124" y="23" fontFamily="system-ui" fontSize="11" fill="oklch(0.48 0.015 220)">History</text>

                {/* Settings tab */}
                <rect x="156" y="0" width="76" height="40" rx="6" fill="transparent" />
                {/* Settings icon */}
                <circle cx="194" cy="20" r="4" fill="none" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" />
                <path d="M 194 16 L 194 24 M 190 20 L 198 20" stroke="oklch(0.48 0.015 220)" strokeWidth="1.5" strokeLinecap="round" />
                <text x="202" y="23" fontFamily="system-ui" fontSize="11" fill="oklch(0.48 0.015 220)">Settings</text>
              </g>
            </g>

            {/* Chat messages */}
            <g transform="translate(12, 68)">
              {/* Message 1: User question */}
              <g opacity="0">
                <rect x="20" y="0" width="216" height="52" rx="8" fill="oklch(0.50 0.16 235)" opacity="0.1" />
                <text x="28" y="20" fontFamily="system-ui" fontSize="13" fill="oklch(0.15 0.01 220)">
                  <tspan x="28" dy="0">Create a getting started</tspan>
                  <tspan x="28" dy="18">guide for new users</tspan>
                </text>
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.03;0.94;1" dur="18s" repeatCount="indefinite" />
              </g>

              {/* Message 2: AI response with tool call */}
              <g opacity="0">
                <rect x="0" y="64" width="236" height="110" rx="8" fill="oklch(0.985 0.003 230)" />
                <text x="12" y="84" fontFamily="system-ui" fontSize="13" fill="oklch(0.15 0.01 220)" opacity="0.9">
                  <tspan x="12" dy="0">I&apos;ll create that for you.</tspan>
                  <tspan x="12" dy="18">Creating a new document</tspan>
                  <tspan x="12" dy="18">page...</tspan>
                </text>
                {/* Tool call badge */}
                <rect x="12" y="140" width="100" height="24" rx="4" fill="oklch(0.50 0.16 235)" opacity="0.15" />
                <path d="M 20 150 L 22 152 L 20 154 M 24 148 L 26 152 L 24 156" stroke="oklch(0.50 0.16 235)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                <text x="30" y="157" fontFamily="system-ui" fontSize="11" fontWeight="500" fill="oklch(0.50 0.16 235)">create_page</text>
                <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.11;0.14;0.94;1" dur="18s" repeatCount="indefinite" />
              </g>

              {/* Message 3: AI confirmation */}
              <g opacity="0">
                <rect x="0" y="186" width="236" height="80" rx="8" fill="oklch(0.985 0.003 230)" />
                <text x="12" y="206" fontFamily="system-ui" fontSize="13" fill="oklch(0.15 0.01 220)" opacity="0.9">
                  <tspan x="12" dy="0">Page created! Now I&apos;ll</tspan>
                  <tspan x="12" dy="18">add content to the guide...</tspan>
                </text>
                {/* Tool call badge */}
                <rect x="12" y="240" width="110" height="24" rx="4" fill="oklch(0.50 0.16 235)" opacity="0.15" />
                <path d="M 20 252 L 22 254 L 20 256 M 24 250 L 26 254 L 24 258" stroke="oklch(0.50 0.16 235)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                <text x="30" y="257" fontFamily="system-ui" fontSize="11" fontWeight="500" fill="oklch(0.50 0.16 235)">update_page</text>
                <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.27;0.30;0.94;1" dur="18s" repeatCount="indefinite" />
              </g>

              {/* Message 4: AI completion */}
              <g opacity="0">
                <rect x="0" y="278" width="236" height="95" rx="8" fill="oklch(0.985 0.003 230)" />
                <text x="12" y="298" fontFamily="system-ui" fontSize="13" fill="oklch(0.15 0.01 220)" opacity="0.9">
                  <tspan x="12" dy="0">Done! I&apos;ve created a</tspan>
                  <tspan x="12" dy="18">&quot;Getting Started&quot; guide</tspan>
                  <tspan x="12" dy="18">with welcome content,</tspan>
                  <tspan x="12" dy="18">key features, and next steps.</tspan>
                </text>
                <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.44;0.47;0.94;1" dur="18s" repeatCount="indefinite" />
              </g>
            </g>

            {/* Input Area at bottom */}
            <g transform="translate(12, 680)">
              <rect x="0" y="0" width="236" height="64" fill="transparent" />
              <line x1="0" y1="0" x2="236" y2="0" stroke="oklch(0.90 0.005 230 / 0.08)" strokeWidth="1" />

              {/* Textarea */}
              <rect
                x="0"
                y="12"
                width="188"
                height="40"
                rx="6"
                fill="oklch(0.985 0.003 230)"
                stroke="oklch(0.90 0.005 230)"
                strokeWidth="1"
              />
              <text
                x="12"
                y="36"
                fontFamily="system-ui, -apple-system, sans-serif"
                fontSize="13"
                fill="oklch(0.48 0.015 220)"
              >
                Message AI...
              </text>

              {/* Send button */}
              <rect
                x="196"
                y="12"
                width="40"
                height="40"
                rx="6"
                fill="oklch(0.50 0.16 235)"
              />
              {/* Send icon */}
              <g transform="translate(226, 22) scale(-0.833, 0.833)">
                <path
                  d="M14.4376 15.3703L12.3042 19.5292C11.9326 20.2537 10.8971 20.254 10.525 19.5297L4.24059 7.2971C3.81571 6.47007 4.65077 5.56156 5.51061 5.91537L18.5216 11.2692C19.2984 11.5889 19.3588 12.6658 18.6227 13.0704L14.4376 15.3703ZM14.4376 15.3703L5.09594 6.90886"
                  stroke="oklch(0.98 0.005 235)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  fill="none"
                />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
