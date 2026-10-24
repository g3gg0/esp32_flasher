.PHONY: all
all:
	python3 ../scripts/build.py --target $(notdir $(CURDIR))
