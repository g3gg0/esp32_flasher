/* Run the actual firmware parser/dispatcher against a host byte stream. */
#include <stdio.h>
#include "platform.h"
#include "protocol.h"
void rpc_receive_byte(uint8_t byte);
void platform_init(void) {}
int platform_rx(uint8_t *byte) { (void)byte; return 1; }
void platform_tx(uint8_t byte) { putchar(byte); }
void platform_flush(void) {}
void platform_delay(uint32_t us) { (void)us; }
void platform_prepare_register_write(uint32_t address, uint32_t value, uint32_t mask) {
    (void)address; (void)value; (void)mask;
}
uint32_t platform_cycles(void) {
#ifdef RPC_RMT_TEST
    extern uint32_t rmt_test_cycles(void);return rmt_test_cycles();
#else
    static uint32_t cycles; return cycles += 10;
#endif
}
uint32_t platform_ticks_per_us(void) { return 1; }
int platform_register_allowed(uint32_t address, int write) {
    (void)write;
#ifdef RPC_CAPTURE_TEST
    return address>=0x60000000&&address<0x60001000&&!(address&3);
#else
    (void)address;return 0;
#endif
}
void platform_identity(void *packet) {
    rpc_identity_t *id = packet;
    id->cpu_cores = 1;
    const char name[] = "esp32c3";
    for (unsigned i = 0; i < sizeof(name); ++i) id->chip[i] = name[i];
}
int main(void) {
    int byte;
    while ((byte = getchar()) != EOF) rpc_receive_byte((uint8_t)byte);
    return 0;
}
