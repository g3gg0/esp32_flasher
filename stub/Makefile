TARGETS := $(notdir $(patsubst %/target.json,%,$(wildcard esp32*/target.json)))
.NOTPARALLEL:
.PHONY: all prepared protocol fuses check $(TARGETS)
all: $(TARGETS)
prepared: all
protocol:
	python3 scripts/generate-protocol.py
	python3 scripts/targets.py
fuses:
	python3 scripts/generate-fuses.py
check:
	python3 scripts/generate-protocol.py --check
	python3 scripts/targets.py --check
$(TARGETS):
	$(MAKE) -C $@
