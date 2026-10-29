#pragma once
#include <stdint.h>

/* The RMT clock is independent of the CPU clock. Keep integer-Hz results so
 * the host can encode pulse durations using the exact negotiated rate. */
static inline unsigned rmt_clock_divider(uint32_t source, uint32_t requested) {
    uint32_t best_error = UINT32_MAX;
    unsigned divider = 0;
    for (unsigned d = 1; d <= 256; ++d) if (!(source % d)) {
        uint32_t hz = source / d;
        uint32_t error = hz > requested ? hz - requested : requested - hz;
        if (hz && error < best_error) { best_error = error; divider = d; }
    }
    return divider;
}
