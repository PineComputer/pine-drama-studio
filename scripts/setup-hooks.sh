#!/bin/sh
# Run once after cloning: enables the repository's git hooks.
git config core.hooksPath .githooks && echo "hooks enabled"
