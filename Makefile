# Entry points for installing and operating the bot from a checkout, on macOS and Linux.
# Windows is not covered; use the npm commands in README.md there.

.DEFAULT_GOAL := help
.PHONY: help install

CURRENT_UID := $(shell id -u)

help:
	@printf 'Usage: make <target>\n\n'
	@printf '  %-10s %s\n' 'install' 'Install dependencies, build, and link the opencode-telegram command from this checkout'
	@printf '  %-10s %s\n' 'help' 'Show this list'

install:
	$(if $(filter 0,$(CURRENT_UID)),$(error make install must not run as root; run it as the user who will use the bot))
	npm ci
	npm run build
	npm link
