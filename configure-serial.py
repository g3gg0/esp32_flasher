#!/usr/bin/env python3
"""
Configure serial port for raw binary data without any terminal processing.
This bypasses Cygwin's terminal discipline issues with control characters like 0x16.
"""

import sys
import termios
import os

def configure_serial_raw(port_path, baudrate=115200):
    """Configure serial port for raw binary data."""
    try:
        fd = os.open(port_path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        
        # Get current settings
        attrs = termios.tcgetattr(fd)
        
        # Set baud rate - use only rates available on all systems
        baudrates = {}
        for rate in [115200, 230400, 460800, 921600]:
            baud_attr = f'B{rate}'
            if hasattr(termios, baud_attr):
                baudrates[rate] = getattr(termios, baud_attr)
        
        if baudrate not in baudrates:
            print(f"Warning: Baudrate {baudrate} not available, using 115200")
            baudrate = 115200
        baud = baudrates.get(baudrate, termios.B115200)
        
        # attrs = [iflag, oflag, cflag, lflag, ispeed, ospeed, cc]
        iflag, oflag, cflag, lflag, ispeed, ospeed, cc = attrs
        
        # Input flags: disable all processing
        iflag = 0
        
        # Output flags: disable all processing
        oflag = 0
        
        # Control flags: 8 bits, 1 stop bit, no parity, no flow control
        cflag = termios.CS8 | termios.CREAD | termios.CLOCAL
        
        # Local flags: disable all line processing
        lflag = 0
        
        # Set control characters
        cc[termios.VMIN] = 0   # Non-blocking read
        cc[termios.VTIME] = 0  # No timeout
        
        # Apply settings
        termios.tcsetattr(fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, baud, baud, cc])
        
        print(f"[configure-serial] Configured {port_path} for raw binary mode")
        print(f"[configure-serial] Baud rate: {baudrate}")
        print(f"[configure-serial] iflag=0, oflag=0, lflag=0 (all processing disabled)")
        print(f"[configure-serial] VMIN=0, VTIME=0 (non-blocking)")
        
        os.close(fd)
        sys.exit(0)
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    port = sys.argv[1] if len(sys.argv) > 1 else '/dev/ttyS0'
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else 115200
    configure_serial_raw(port, baud)
