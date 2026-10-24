TARGETS := esp32c3 esp32p4 esp32 esp32s2 esp32s3 esp32c2 esp32c5 esp32c6 esp32c61 esp32h2
.PHONY: all prepared protocol check $(TARGETS)
all: esp32c3 esp32p4
prepared: $(TARGETS)
protocol:
	python3 scripts/generate-protocol.py
check:
	python3 scripts/generate-protocol.py --check
$(TARGETS):
	$(MAKE) -C $@
