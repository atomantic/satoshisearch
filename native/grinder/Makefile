# Native grinder: libsecp256k1 + pthreads hot loop.
# Build: make -C native/grinder
# Output: native/grinder/satoshi-grind

ROOT := $(abspath .)
SECP := $(ROOT)/third_party/secp256k1
SECP_BUILD := $(SECP)/build
SECP_LIB := $(SECP_BUILD)/lib/libsecp256k1.a

CC ?= cc
CFLAGS ?= -O3 -std=c11 -Wall -Wextra -Wno-unused-parameter
CFLAGS += -I$(SECP)/include -I$(ROOT)
LDFLAGS ?=
LIBS := $(SECP_LIB) -lpthread

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Linux)
  LIBS += -lrt
endif

SRCS := main.c hash.c set.c
OBJS := $(SRCS:.c=.o)
BIN := satoshi-grind

.PHONY: all clean distclean secp selftest bench

all: $(BIN)

$(SECP)/include/secp256k1.h:
	@echo "Cloning libsecp256k1..."
	mkdir -p $(ROOT)/third_party
	git clone --depth 1 https://github.com/bitcoin-core/secp256k1.git $(SECP)

$(SECP_LIB): $(SECP)/include/secp256k1.h
	cmake -S $(SECP) -B $(SECP_BUILD) \
	  -DCMAKE_BUILD_TYPE=Release \
	  -DBUILD_SHARED_LIBS=OFF \
	  -DSECP256K1_ENABLE_MODULE_ECDH=OFF \
	  -DSECP256K1_ENABLE_MODULE_RECOVERY=OFF \
	  -DSECP256K1_ENABLE_MODULE_EXTRAKEYS=OFF \
	  -DSECP256K1_ENABLE_MODULE_SCHNORRSIG=OFF \
	  -DSECP256K1_ENABLE_MODULE_ELLSWIFT=OFF \
	  -DSECP256K1_ENABLE_MODULE_MUSIG=OFF \
	  -DSECP256K1_ENABLE_MODULE_SILENTPAYMENTS=OFF \
	  -DSECP256K1_BUILD_BENCHMARK=OFF \
	  -DSECP256K1_BUILD_TESTS=OFF \
	  -DSECP256K1_BUILD_EXHAUSTIVE_TESTS=OFF \
	  -DSECP256K1_BUILD_CTIME_TESTS=OFF \
	  -DSECP256K1_BUILD_EXAMPLES=OFF
	cmake --build $(SECP_BUILD) -j$$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

secp: $(SECP_LIB)

%.o: %.c hash.h set.h $(SECP_LIB)
	$(CC) $(CFLAGS) -c $< -o $@

$(BIN): $(OBJS) $(SECP_LIB)
	$(CC) $(CFLAGS) -o $@ $(OBJS) $(LIBS) $(LDFLAGS)

selftest: $(BIN)
	./$(BIN) --selftest

bench: $(BIN)
	./$(BIN) --bench 500000
	./$(BIN) --bench-range 500000

clean:
	rm -f $(OBJS) $(BIN)

distclean: clean
	rm -rf $(SECP_BUILD)
