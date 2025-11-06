# Workflow Examples

This document provides example workflow templates for common use cases in PageSpace.

## Table of Contents

1. [Content Creation Workflows](#content-creation-workflows)
2. [Development Workflows](#development-workflows)
3. [Research & Analysis Workflows](#research--analysis-workflows)
4. [Review & Quality Workflows](#review--quality-workflows)

## Content Creation Workflows

### Blog Post Creation Workflow

**Category:** Content Generation
**Tags:** writing, blog, content, SEO
**Steps:** 5

#### Workflow Definition

```json
{
  "name": "Blog Post Creation Workflow",
  "description": "Create comprehensive, SEO-optimized blog posts with research, outline, drafting, editing, and optimization steps",
  "category": "Content Generation",
  "tags": ["writing", "blog", "content", "SEO"],
  "isPublic": true,
  "steps": [
    {
      "stepOrder": 0,
      "agentId": "research-agent",
      "promptTemplate": "Research the following topic in depth: {{initialContext.topic}}\n\nTarget Audience: {{initialContext.audience}}\n\nProvide:\n1. Key concepts and definitions\n2. Current trends and statistics\n3. Common questions and pain points\n4. Credible sources and references\n5. Unique angles or insights",
      "requiresUserInput": false
    },
    {
      "stepOrder": 1,
      "agentId": "outline-agent",
      "promptTemplate": "Create a detailed blog post outline for: {{initialContext.topic}}\n\nBased on this research:\n{{step0.output}}\n\nTarget word count: {{initialContext.wordCount}}\nTarget audience: {{initialContext.audience}}\n\nInclude:\n1. Compelling headline options (3-5)\n2. Introduction hook\n3. Main sections with subsections\n4. Key points for each section\n5. Conclusion approach\n6. CTA suggestions",
      "requiresUserInput": false
    },
    {
      "stepOrder": 2,
      "agentId": "writer-agent",
      "promptTemplate": "Write a complete blog post following this outline:\n{{step1.output}}\n\nUse the research data:\n{{step0.output}}\n\nGuidelines:\n- Engaging, conversational tone\n- Clear, scannable formatting\n- Include relevant examples\n- Natural keyword integration\n- Strong introduction and conclusion\n- Target word count: {{initialContext.wordCount}}",
      "requiresUserInput": false
    },
    {
      "stepOrder": 3,
      "agentId": "editor-agent",
      "promptTemplate": "Edit and improve this blog post:\n{{step2.output}}\n\nFocus on:\n1. Clarity and readability\n2. Flow and transitions\n3. Grammar and style\n4. Tone consistency\n5. Removing redundancy\n6. Strengthening weak sections\n\nProvide the polished version.",
      "requiresUserInput": false
    },
    {
      "stepOrder": 4,
      "agentId": "seo-agent",
      "promptTemplate": "Optimize this blog post for SEO:\n{{step3.output}}\n\nPrimary keyword: {{initialContext.keyword}}\n\nProvide:\n1. Optimized title and meta description\n2. Header tag structure (H1, H2, H3)\n3. Internal linking suggestions\n4. Image alt text suggestions\n5. Featured snippet opportunities\n6. Final SEO-optimized version",
      "requiresUserInput": false
    }
  ]
}
```

#### Initial Context Example

```json
{
  "topic": "AI-Powered Workflow Automation",
  "audience": "Small business owners",
  "wordCount": "1500",
  "keyword": "workflow automation tools"
}
```

---

### Social Media Campaign Workflow

**Category:** Content Generation
**Tags:** social media, marketing, campaign
**Steps:** 4

#### Workflow Definition

```json
{
  "name": "Social Media Campaign Workflow",
  "description": "Plan and create a multi-platform social media campaign with strategy, content creation, and scheduling",
  "category": "Content Generation",
  "tags": ["social media", "marketing", "campaign"],
  "isPublic": true,
  "steps": [
    {
      "stepOrder": 0,
      "agentId": "strategy-agent",
      "promptTemplate": "Create a social media campaign strategy for:\n\nProduct/Service: {{initialContext.product}}\nCampaign Goal: {{initialContext.goal}}\nTarget Audience: {{initialContext.audience}}\nDuration: {{initialContext.duration}}\nPlatforms: {{initialContext.platforms}}\n\nProvide:\n1. Campaign theme and messaging\n2. Content pillars\n3. Posting frequency per platform\n4. Hashtag strategy\n5. Engagement tactics\n6. Success metrics",
      "requiresUserInput": false
    },
    {
      "stepOrder": 1,
      "agentId": "content-creator-agent",
      "promptTemplate": "Create social media posts based on this strategy:\n{{step0.output}}\n\nProduct/Service: {{initialContext.product}}\nNumber of posts: {{initialContext.postCount}}\n\nFor each post provide:\n1. Platform (Instagram, Twitter, LinkedIn, etc.)\n2. Post copy with appropriate length\n3. Hashtags\n4. Image/video description\n5. Best posting time\n6. CTA",
      "requiresUserInput": false
    },
    {
      "stepOrder": 2,
      "agentId": "review-agent",
      "promptTemplate": "Review these social media posts for brand consistency and effectiveness:\n{{step1.output}}\n\nBrand voice: {{initialContext.brandVoice}}\nCampaign goal: {{initialContext.goal}}\n\nCheck for:\n1. Message alignment\n2. Tone consistency\n3. Platform best practices\n4. CTA effectiveness\n5. Engagement potential\n\nProvide improved versions if needed.",
      "requiresUserInput": true,
      "inputSchema": {
        "type": "object",
        "properties": {
          "feedback": {
            "type": "textarea",
            "label": "Any specific feedback or changes?",
            "required": false
          }
        }
      }
    },
    {
      "stepOrder": 3,
      "agentId": "scheduler-agent",
      "promptTemplate": "Create a posting schedule for these social media posts:\n{{step2.output}}\n\nCampaign duration: {{initialContext.duration}}\nPlatforms: {{initialContext.platforms}}\nUser feedback: {{step2.userInput}}\n\nProvide:\n1. Calendar with dates and times\n2. Platform assignment\n3. Post sequence rationale\n4. Peak engagement times\n5. Campaign milestones\n6. CSV format for import to scheduling tools",
      "requiresUserInput": false
    }
  ]
}
```

---

## Development Workflows

### Feature Implementation Workflow

**Category:** Development
**Tags:** development, planning, implementation
**Steps:** 6

#### Workflow Definition

```json
{
  "name": "Feature Implementation Workflow",
  "description": "Complete feature development workflow from requirements to implementation plan",
  "category": "Development",
  "tags": ["development", "planning", "implementation"],
  "isPublic": true,
  "steps": [
    {
      "stepOrder": 0,
      "agentId": "requirements-agent",
      "promptTemplate": "Analyze and document requirements for this feature:\n\nFeature: {{initialContext.featureName}}\nDescription: {{initialContext.featureDescription}}\nBusiness Goal: {{initialContext.businessGoal}}\n\nProvide:\n1. Functional requirements\n2. Non-functional requirements\n3. User stories with acceptance criteria\n4. Edge cases and constraints\n5. Dependencies on existing features\n6. Success metrics",
      "requiresUserInput": false
    },
    {
      "stepOrder": 1,
      "agentId": "architecture-agent",
      "promptTemplate": "Design the architecture for this feature:\n\nRequirements:\n{{step0.output}}\n\nCurrent tech stack: {{initialContext.techStack}}\n\nProvide:\n1. System architecture diagram (text description)\n2. Component breakdown\n3. Data models and schema changes\n4. API endpoints needed\n5. Integration points\n6. Technology choices and rationale",
      "requiresUserInput": false
    },
    {
      "stepOrder": 2,
      "agentId": "security-agent",
      "promptTemplate": "Perform security analysis for this feature design:\n\nArchitecture:\n{{step1.output}}\n\nRequirements:\n{{step0.output}}\n\nIdentify:\n1. Security vulnerabilities\n2. Authentication/authorization requirements\n3. Data protection needs\n4. Input validation requirements\n5. Potential attack vectors\n6. Security best practices to implement",
      "requiresUserInput": false
    },
    {
      "stepOrder": 3,
      "agentId": "implementation-planner-agent",
      "promptTemplate": "Create a detailed implementation plan:\n\nArchitecture:\n{{step1.output}}\n\nSecurity considerations:\n{{step2.output}}\n\nRequirements:\n{{step0.output}}\n\nTeam size: {{initialContext.teamSize}}\nTimeline: {{initialContext.timeline}}\n\nProvide:\n1. Development phases\n2. Task breakdown with estimates\n3. Milestone definitions\n4. Testing strategy\n5. Deployment plan\n6. Risk mitigation strategies",
      "requiresUserInput": true,
      "inputSchema": {
        "type": "object",
        "properties": {
          "priorityAdjustments": {
            "type": "textarea",
            "label": "Any priority adjustments or constraints?",
            "required": false
          },
          "resourceLimitations": {
            "type": "text",
            "label": "Resource limitations or dependencies?",
            "required": false
          }
        }
      }
    },
    {
      "stepOrder": 4,
      "agentId": "documentation-agent",
      "promptTemplate": "Create comprehensive documentation:\n\nImplementation plan:\n{{step3.output}}\n\nUser input:\n{{step3.userInput}}\n\nArchitecture:\n{{step1.output}}\n\nGenerate:\n1. Technical specification document\n2. API documentation\n3. Database schema documentation\n4. Developer setup guide\n5. Testing guidelines\n6. Deployment instructions",
      "requiresUserInput": false
    },
    {
      "stepOrder": 5,
      "agentId": "summary-agent",
      "promptTemplate": "Create an executive summary of this feature implementation:\n\nRequirements:\n{{step0.output}}\n\nArchitecture:\n{{step1.output}}\n\nImplementation Plan:\n{{step3.output}}\n\nProvide:\n1. Feature overview (2-3 paragraphs)\n2. Key deliverables\n3. Timeline summary\n4. Resource requirements\n5. Success metrics\n6. Next steps\n\nFormat as a concise executive briefing.",
      "requiresUserInput": false
    }
  ]
}
```

---

### Code Review Workflow

**Category:** Development
**Tags:** code review, quality, security
**Steps:** 5

#### Workflow Definition

```json
{
  "name": "Comprehensive Code Review Workflow",
  "description": "Multi-agent code review covering syntax, security, performance, and documentation",
  "category": "Development",
  "tags": ["code review", "quality", "security"],
  "isPublic": true,
  "steps": [
    {
      "stepOrder": 0,
      "agentId": "syntax-reviewer-agent",
      "promptTemplate": "Review this code for syntax, style, and best practices:\n\n```\n{{initialContext.code}}\n```\n\nLanguage: {{initialContext.language}}\nFramework: {{initialContext.framework}}\n\nCheck for:\n1. Code style compliance\n2. Naming conventions\n3. Code organization\n4. Design patterns usage\n5. SOLID principles\n6. Code smells\n\nProvide specific line-by-line feedback.",
      "requiresUserInput": false
    },
    {
      "stepOrder": 1,
      "agentId": "security-reviewer-agent",
      "promptTemplate": "Perform security review of this code:\n\n```\n{{initialContext.code}}\n```\n\nPrevious review:\n{{step0.output}}\n\nIdentify:\n1. Security vulnerabilities\n2. Input validation issues\n3. Authentication/authorization flaws\n4. Data exposure risks\n5. Injection attack vectors\n6. Cryptography issues\n\nRate severity (Critical, High, Medium, Low) for each issue.",
      "requiresUserInput": false
    },
    {
      "stepOrder": 2,
      "agentId": "performance-reviewer-agent",
      "promptTemplate": "Analyze performance and optimization opportunities:\n\n```\n{{initialContext.code}}\n```\n\nPrevious reviews:\n{{step0.output}}\n{{step1.output}}\n\nExamine:\n1. Algorithm complexity\n2. Database query efficiency\n3. Memory usage\n4. Network calls optimization\n5. Caching opportunities\n6. Resource cleanup\n\nPrioritize by impact on performance.",
      "requiresUserInput": false
    },
    {
      "stepOrder": 3,
      "agentId": "documentation-reviewer-agent",
      "promptTemplate": "Review documentation completeness:\n\n```\n{{initialContext.code}}\n```\n\nCheck for:\n1. Function/method documentation\n2. Complex logic explanations\n3. API documentation\n4. Usage examples\n5. Edge case documentation\n6. Inline comments where needed\n\nSuggest improvements.",
      "requiresUserInput": false
    },
    {
      "stepOrder": 4,
      "agentId": "summary-reviewer-agent",
      "promptTemplate": "Compile comprehensive code review report:\n\nSyntax Review:\n{{step0.output}}\n\nSecurity Review:\n{{step1.output}}\n\nPerformance Review:\n{{step2.output}}\n\nDocumentation Review:\n{{step3.output}}\n\nProvide:\n1. Executive summary\n2. Critical issues (must fix)\n3. Important issues (should fix)\n4. Nice-to-have improvements\n5. Positive highlights\n6. Overall recommendation (Approve, Approve with changes, Reject)\n7. Estimated effort to address issues",
      "requiresUserInput": false
    }
  ]
}
```

---

## Research & Analysis Workflows

### Market Research Workflow

**Category:** Research
**Tags:** research, market analysis, competitive intelligence
**Steps:** 5

#### Workflow Definition

```json
{
  "name": "Market Research & Analysis Workflow",
  "description": "Comprehensive market research including competitor analysis, trends, and strategic recommendations",
  "category": "Research",
  "tags": ["research", "market analysis", "competitive intelligence"],
  "isPublic": true,
  "steps": [
    {
      "stepOrder": 0,
      "agentId": "data-collector-agent",
      "promptTemplate": "Gather market data for:\n\nMarket: {{initialContext.market}}\nProduct Category: {{initialContext.category}}\nTarget Region: {{initialContext.region}}\n\nCollect:\n1. Market size and growth rate\n2. Key players and market share\n3. Customer demographics\n4. Pricing trends\n5. Distribution channels\n6. Regulatory environment\n\nProvide data sources for each point.",
      "requiresUserInput": false
    },
    {
      "stepOrder": 1,
      "agentId": "competitor-analyst-agent",
      "promptTemplate": "Analyze top competitors in this market:\n\nMarket data:\n{{step0.output}}\n\nTop competitors: {{initialContext.competitors}}\n\nFor each competitor provide:\n1. Market position and strategy\n2. Product offerings\n3. Pricing strategy\n4. Strengths and weaknesses\n5. Customer reviews and sentiment\n6. Unique value propositions\n7. Recent moves and announcements",
      "requiresUserInput": false
    },
    {
      "stepOrder": 2,
      "agentId": "trend-analyst-agent",
      "promptTemplate": "Identify and analyze market trends:\n\nMarket data:\n{{step0.output}}\n\nCompetitor analysis:\n{{step1.output}}\n\nIdentify:\n1. Emerging trends\n2. Declining trends\n3. Technology disruptions\n4. Consumer behavior shifts\n5. Market opportunities\n6. Potential threats\n\nFor each trend, assess impact and timeline.",
      "requiresUserInput": false
    },
    {
      "stepOrder": 3,
      "agentId": "swot-agent",
      "promptTemplate": "Create SWOT analysis:\n\nOur position: {{initialContext.ourPosition}}\n\nMarket data:\n{{step0.output}}\n\nCompetitor analysis:\n{{step1.output}}\n\nTrend analysis:\n{{step2.output}}\n\nProvide comprehensive SWOT:\n1. Strengths (internal, positive)\n2. Weaknesses (internal, negative)\n3. Opportunities (external, positive)\n4. Threats (external, negative)\n\nInclude specific, actionable insights.",
      "requiresUserInput": true,
      "inputSchema": {
        "type": "object",
        "properties": {
          "additionalContext": {
            "type": "textarea",
            "label": "Any additional context about our position or capabilities?",
            "required": false
          }
        }
      }
    },
    {
      "stepOrder": 4,
      "agentId": "strategy-agent",
      "promptTemplate": "Develop strategic recommendations:\n\nMarket data:\n{{step0.output}}\n\nCompetitor analysis:\n{{step1.output}}\n\nTrend analysis:\n{{step2.output}}\n\nSWOT analysis:\n{{step3.output}}\n\nUser context:\n{{step3.userInput}}\n\nProvide:\n1. Market entry/expansion strategy\n2. Competitive positioning\n3. Product/service recommendations\n4. Pricing strategy\n5. Marketing approach\n6. Risk mitigation\n7. Short-term actions (0-6 months)\n8. Long-term strategy (6-24 months)",
      "requiresUserInput": false
    }
  ]
}
```

---

## Review & Quality Workflows

### Document Review Workflow

**Category:** Quality Assurance
**Tags:** review, editing, quality
**Steps:** 4

#### Workflow Definition

```json
{
  "name": "Document Review & Improvement Workflow",
  "description": "Multi-stage document review for quality, clarity, and effectiveness",
  "category": "Quality Assurance",
  "tags": ["review", "editing", "quality"],
  "isPublic": true,
  "steps": [
    {
      "stepOrder": 0,
      "agentId": "content-reviewer-agent",
      "promptTemplate": "Review this document for content quality:\n\n{{initialContext.document}}\n\nDocument type: {{initialContext.documentType}}\nTarget audience: {{initialContext.audience}}\n\nEvaluate:\n1. Content completeness\n2. Logical flow and structure\n3. Clarity of message\n4. Supporting evidence\n5. Relevance to audience\n6. Missing information\n\nProvide a detailed assessment with specific examples.",
      "requiresUserInput": false
    },
    {
      "stepOrder": 1,
      "agentId": "style-editor-agent",
      "promptTemplate": "Edit for style and readability:\n\nDocument:\n{{initialContext.document}}\n\nContent review:\n{{step0.output}}\n\nDocument type: {{initialContext.documentType}}\nStyle guide: {{initialContext.styleGuide}}\n\nFocus on:\n1. Grammar and punctuation\n2. Sentence structure\n3. Word choice and tone\n4. Consistency\n5. Readability level\n6. Active vs passive voice\n\nProvide:\n- List of major style issues\n- Suggested rewrites for problem sections\n- Overall style score (1-10)",
      "requiresUserInput": false
    },
    {
      "stepOrder": 2,
      "agentId": "technical-accuracy-agent",
      "promptTemplate": "Verify technical accuracy:\n\nDocument:\n{{initialContext.document}}\n\nDocument type: {{initialContext.documentType}}\nSubject matter: {{initialContext.subject}}\n\nCheck:\n1. Factual accuracy\n2. Technical terminology\n3. Data and statistics\n4. Citations and references\n5. Technical claims\n6. Industry standards compliance\n\nFlag any inaccuracies or questionable claims.",
      "requiresUserInput": true,
      "inputSchema": {
        "type": "object",
        "properties": {
          "subjectMatterFeedback": {
            "type": "textarea",
            "label": "Any subject matter expertise to add?",
            "required": false
          },
          "knownIssues": {
            "type": "textarea",
            "label": "Any known issues to address?",
            "required": false
          }
        }
      }
    },
    {
      "stepOrder": 3,
      "agentId": "final-polish-agent",
      "promptTemplate": "Create final polished version:\n\nOriginal document:\n{{initialContext.document}}\n\nContent review:\n{{step0.output}}\n\nStyle review:\n{{step1.output}}\n\nTechnical review:\n{{step2.output}}\n\nUser feedback:\n{{step2.userInput}}\n\nProvide:\n1. Final polished document\n2. Summary of changes made\n3. Improvement highlights\n4. Recommendations for future documents\n5. Quality score (1-10) with breakdown",
      "requiresUserInput": false
    }
  ]
}
```

---

## Usage Notes

### How to Import Templates

These templates can be imported via:

1. **Manual Creation**: Copy the step definitions into the workflow builder UI
2. **API Import**: POST to `/api/workflows/templates` with the JSON payload
3. **Database Seed**: Add to a migration or seed script

### Customizing Templates

When customizing these templates:

1. **Update Agent IDs**: Replace placeholder agent IDs with your actual AI_CHAT page IDs
2. **Adjust Prompts**: Tailor prompts to your specific needs and style
3. **Modify Context**: Change `initialContext` keys to match your data
4. **Add/Remove Steps**: Adjust workflow length based on complexity
5. **User Input**: Add or remove user input points as needed

### Template Variables Reference

All templates use these variable patterns:
- `{{initialContext.key}}`: Access initial context data
- `{{step0.output}}`, `{{step1.output}}`: Access previous step outputs
- `{{stepN.userInput}}`: Access user input from specific steps
- `{{context}}`: Full accumulated context (use sparingly)

---

## Contributing

Have a great workflow template? Submit it to the PageSpace community!

1. Test your workflow thoroughly
2. Document initial context requirements
3. Include example usage scenarios
4. Submit via PR or community forum
