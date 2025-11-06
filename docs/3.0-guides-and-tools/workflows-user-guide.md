# Workflows - User Guide

## Overview

The Workflows system in PageSpace enables you to create and execute multi-step AI agent processes that automatically pass context between steps. Workflows are perfect for complex tasks that require multiple specialized AI agents working in sequence.

## Table of Contents

1. [What are Workflows?](#what-are-workflows)
2. [Using Workflows](#using-workflows)
3. [Creating Custom Workflows](#creating-custom-workflows)
4. [Template Variables](#template-variables)
5. [Pre-built Workflow Templates](#pre-built-workflow-templates)
6. [Best Practices](#best-practices)

## What are Workflows?

A workflow is a sequential list of steps where each step:
- Uses a specific AI agent (AI_CHAT page)
- Receives context from previous steps
- Executes with a customized prompt
- Optionally pauses for user input
- Passes its output to the next step

### Key Concepts

**Workflow Template**: A reusable definition of a workflow with configured steps
**Workflow Execution**: A running instance of a workflow template
**Step**: A single AI agent task within a workflow
**Accumulated Context**: All data collected throughout the workflow execution
**User Input**: Manual input collected at specific decision points

## Using Workflows

### Discovering Workflows

1. Navigate to `/workflows` in PageSpace
2. Browse available workflow templates
3. Filter by:
   - **Category**: Content Generation, Development, Research, etc.
   - **Tags**: Specific keywords
   - **Search**: Name or description
4. Click "View Details" to see the step-by-step breakdown

### Starting a Workflow

1. From the workflow list, click **"Start Workflow"**
2. Or from the template detail page, click **"Start Workflow"**
3. You'll be redirected to the execution view at `/workflows/executions/[id]`

### Monitoring Execution

The execution view shows:
- **Progress Bar**: Current step and percentage complete
- **Step List**: All steps with status indicators
- **Step Details**: Expand to see agent input and output
- **Accumulated Context**: All collected data
- **Controls**: Pause, resume, or cancel the execution

### Providing User Input

When a step requires user input:
1. The workflow pauses automatically
2. A form appears with the required fields
3. Fill in the information
4. Click **"Submit"**
5. The workflow continues automatically

### Execution Status

- 🔵 **Running**: Workflow is actively executing
- ⏸️ **Paused**: Waiting for user input or manually paused
- ✅ **Completed**: All steps finished successfully
- ❌ **Failed**: An error occurred during execution
- 🚫 **Cancelled**: Manually cancelled by user

## Creating Custom Workflows

### Step 1: Access the Builder

Navigate to `/workflows/new` or click **"Create Workflow"** from the workflows page.

### Step 2: Configure Metadata

Fill in the workflow template information:

- **Name** (required): Clear, descriptive name (e.g., "Blog Post Creation Workflow")
- **Description**: What the workflow does and when to use it
- **Drive**: Which drive the template belongs to
- **Category**: Content Generation, Development, Research, etc.
- **Tags**: Keywords for searching (comma-separated)
- **Public**: Make the template available to all users

### Step 3: Add Steps

Click **"Add Step"** to create a new workflow step:

1. **Select Agent**: Choose which AI_CHAT page to use
2. **Prompt Template**: Write the prompt with template variables
3. **Requires User Input**: Toggle if this step needs manual input
4. **Input Schema**: Define the fields to collect (if applicable)

### Step 4: Configure Prompts

Use template variables to reference context:

```
Analyze the following research: {{step0.output}}

Based on the analysis, create a detailed plan for {{initialContext.projectName}}.

Previous feedback: {{step1.userInput}}
```

### Step 5: Reorder Steps

Drag and drop steps to change the execution order. Steps are numbered automatically.

### Step 6: Preview

The right sidebar shows a live preview of your workflow:
- All metadata
- Step-by-step breakdown
- Agent assignments
- Summary statistics

### Step 7: Save

Click **"Create Workflow"** to save your template. It will be immediately available for execution.

## Template Variables

Template variables allow you to reference data from previous steps and context.

### Available Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{{context}}` | Full accumulated context (JSON) | All data collected |
| `{{initialContext.key}}` | Initial context value | `{{initialContext.projectName}}` |
| `{{step0.output}}` | Output from step 0 | First step's response |
| `{{step1.output}}` | Output from step 1 | Second step's response |
| `{{stepN.output}}` | Output from step N | Any step's response |
| `{{userInput}}` | User input from current step | Current step's input |
| `{{stepN.userInput}}` | User input from step N | Previous step's input |

### Conditional Logic in Prompts

Instead of complex programmatic conditions, embed logic in your prompts:

```
Review the document: {{step0.output}}

If the document has major issues:
- Create a detailed revision plan
- List all critical problems
- Suggest specific improvements

If the document has only minor issues:
- Create a clean version with suggested edits
- Note any minor improvements needed

If the document is ready:
- Provide final approval with any minor polish suggestions
```

The AI agent will naturally handle the conditional logic based on the context.

## Pre-built Workflow Templates

### Content Creation Workflow

**Steps:**
1. **Research Agent**: Gather information on topic
2. **Outline Agent**: Create structured outline
3. **Writer Agent**: Draft full content
4. **Editor Agent**: Review and polish
5. **SEO Agent**: Optimize for search engines

**Use Case**: Creating comprehensive blog posts, articles, or documentation

### Feature Development Workflow

**Steps:**
1. **Requirements Agent**: Gather and analyze requirements
2. **Architecture Agent**: Design system architecture
3. **Implementation Agent**: Create implementation plan
4. **Review Agent**: Security and code review
5. **Documentation Agent**: Generate documentation

**Use Case**: Planning new features or major code changes

### Market Research Workflow

**Steps:**
1. **Data Collection Agent**: Gather market data
2. **Competitor Analysis Agent**: Analyze competitors
3. **Trend Analysis Agent**: Identify market trends
4. **SWOT Agent**: Create SWOT analysis
5. **Strategy Agent**: Develop strategic recommendations

**Use Case**: Market analysis and competitive intelligence

### Code Review Workflow

**Steps:**
1. **Syntax Review Agent**: Check code quality and style
2. **Security Review Agent**: Identify security issues
3. **Performance Review Agent**: Find optimization opportunities
4. **Documentation Review Agent**: Verify documentation completeness
5. **Summary Agent**: Compile comprehensive review report

**Use Case**: Thorough code review process

## Best Practices

### Designing Effective Workflows

1. **Single Responsibility**: Each step should have one clear purpose
2. **Logical Sequence**: Order steps in a natural progression
3. **Clear Prompts**: Write specific, actionable prompts
4. **Context Passing**: Reference previous steps to maintain continuity
5. **User Input Placement**: Gather input at strategic decision points

### Writing Good Prompts

**Do:**
- Be specific about the task
- Reference relevant context variables
- Provide clear success criteria
- Include examples when helpful
- Use conditional logic in natural language

**Don't:**
- Write vague or ambiguous prompts
- Assume context without referencing it
- Skip error handling instructions
- Over-complicate with too many conditions

### Managing Workflow Complexity

- **Short Workflows** (2-3 steps): Quick, focused tasks
- **Medium Workflows** (4-6 steps): Most common use cases
- **Long Workflows** (7+ steps): Complex, multi-phase processes

### Agent Selection

Choose agents based on:
- **Specialization**: Agents configured for specific domains
- **System Prompts**: Agents with relevant expertise
- **Tool Access**: Agents with necessary tool permissions
- **Model Selection**: Agents using appropriate AI models

### Error Handling

1. **Test Your Workflow**: Run through at least once before sharing
2. **Handle Edge Cases**: Include instructions for unexpected inputs
3. **Monitor Executions**: Check failed workflows for issues
4. **Iterate**: Improve prompts based on actual results

### Performance Optimization

- **Minimize Steps**: Combine related tasks when possible
- **Strategic Input**: Only pause for truly necessary input
- **Efficient Prompts**: Clear and concise to reduce token usage
- **Appropriate Models**: Use lighter models for simpler steps

## Troubleshooting

### Workflow Won't Start

- Check you have access to the drive
- Verify all agents still exist
- Ensure template has at least one step

### Step Fails to Execute

- Review the agent's configuration
- Check if agent has appropriate permissions
- Verify the prompt template is valid
- Look for missing context variables

### Unexpected Results

- Review the accumulated context
- Check agent's system prompt and configuration
- Verify template variables are correct
- Test prompt templates in isolation

### Workflow Hangs

- Check if it's waiting for user input
- Verify the agent is responding
- Review execution logs for errors
- Try pausing and resuming

## API Reference

For programmatic access, see the [Workflows API Documentation](./workflows-api-reference.md).

## Support

For issues or questions:
- Check the [FAQ](./workflows-faq.md)
- Review [example templates](./workflows-examples.md)
- Ask in the PageSpace community
- Submit a bug report if needed
