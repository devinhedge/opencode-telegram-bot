# Entry points for installing and operating the bot from a checkout, on macOS and Linux.
# Windows is not covered; use the npm commands in README.md there.

.DEFAULT_GOAL := help
.PHONY: help install

CURRENT_UID := $(shell id -u 2>/dev/null)
# The id with every digit removed: empty for a numeric id. Plain make functions, no shell, so a
# value passed on the command line is never interpreted by sh.
UID_NON_DIGITS := $(subst 9,,$(subst 8,,$(subst 7,,$(subst 6,,$(subst 5,,$(subst 4,,$(subst 3,,$(subst 2,,$(subst 1,,$(subst 0,,$(CURRENT_UID)))))))))))

help:
	@printf 'Usage: make <target>\n\n'
	@printf '  %-10s %s\n' 'install' 'Install dependencies, build, and link the opencode-telegram command from this checkout'
	@printf '  %-10s %s\n' 'help' 'Show this list'

# Refuses, before any npm command, when the user id is unreadable or is root's.
install:
	$(if $(and $(CURRENT_UID),$(if $(UID_NON_DIGITS),,ok)),,$(error make install cannot determine the user id))
	$(if $(subst 0,,$(CURRENT_UID)),,$(error make install must not run as root; run it as the user who will use the bot))
	npm ci
	npm run build
	npm link
