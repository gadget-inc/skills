# Contributing to Gadget Skills

Thank you for your interest in contributing to the Gadget Skills repository! This document provides guidelines for adding new reference documentation and improving existing skills.

## Adding New Reference Documentation

When adding new reference documentation to the `gadget-best-practices` skill:

### 1. Create a New Reference File

Create a new `.md` file in the `skills/gadget/gadget-best-practices/references/` directory:

```bash
touch skills/gadget/gadget-best-practices/references/your-topic.md
```

### 2. Follow the Existing Format

Each reference document should include:

- **Clear "What is this?" section** - Start with a concise explanation of what the topic covers
- **Code examples with ✅/❌ patterns** - Show both good and bad practices with clear indicators
- **Common pitfalls and gotchas** - Include a section highlighting common mistakes and edge cases
- **Links to related references** - Connect to other relevant documentation in the skill

### 3. Update the Skill Index

After creating your reference file, update the index in `skills/gadget/gadget-best-practices/SKILL.md`:

1. Add your new topic to the appropriate section
2. Include a brief description of what it covers
3. Ensure the file path is correct

### 4. Writing Style Guidelines

- **Use concrete examples over abstract explanations** - Show real code snippets from actual Gadget projects
- **Be specific and actionable** - Provide clear guidance that developers can immediately apply
- **Include context** - Explain *why* a pattern is recommended, not just *what* to do
- **Keep it concise** - Focus on the most important information developers need to know

## Example Reference Structure

```markdown
# Topic Name

## What is this?

[Brief explanation of the topic and when to use it]

## Best Practices

### ✅ Do This

\`\`\`javascript
// Good example with explanation
\`\`\`

### ❌ Don't Do This

\`\`\`javascript
// Bad example with explanation of why it's problematic
\`\`\`

## Common Pitfalls

- **Pitfall 1**: Description and how to avoid it
- **Pitfall 2**: Description and how to avoid it

## Related References

- [Related Topic 1](./related-topic-1.md)
- [Related Topic 2](./related-topic-2.md)
```

## Pull Request Process

1. Fork the repository
2. Create a new branch for your changes (`git checkout -b add-new-reference`)
3. Make your changes following the guidelines above
4. Test that the skill loads correctly with Claude Code
5. Submit a pull request with a clear description of your additions

## Questions or Suggestions?

If you have questions about contributing or suggestions for improvements:

- Open an issue on the GitHub repository
- Join the [Gadget Discord Community](https://ggt.link/discord) and ask in the appropriate channel

## Code of Conduct

Be respectful, constructive, and helpful in all interactions. We're all here to make Gadget development better for everyone.
