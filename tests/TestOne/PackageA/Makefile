SHELL = /bin/bash

build clean: node_modules
	@$(MAKE) -f <(../../../.bin/esy build) $@

node_modules:
	sh ./test.sh
