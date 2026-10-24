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
uint32_t platform_cycles(void) { static uint32_t cycles; return cycles += 10; }
uint32_t platform_ticks_per_us(void) { return 1; }
int platform_register_allowed(uint32_t address, int write) { (void)address; (void)write; return 0; }
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
