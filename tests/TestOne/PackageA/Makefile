SHELL = /bin/bash

all: build

node_modules:
	@sh ./test.sh

%: node_modules
	@$(MAKE) -s -f <(../../../.bin/esy build-eject) $@
