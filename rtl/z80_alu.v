// @intent:responsibility 8-bit 算術論理演算（ALU）およびフラグ（S, Z, H, PV, N, C）の正確な計算
// @intent:cleanroom 完全な自作 Verilog 実装（Pure-Intent Mode）

module z80_alu (
    input  wire [3:0] alu_op,      // 0:ADD, 1:ADC, 2:SUB, 3:SBC, 4:AND, 5:XOR, 6:OR, 7:CP, 8:INC, 9:DEC
    input  wire [7:0] in_a,        // オペランド A (通常 A レジスタまたは r)
    input  wire [7:0] in_b,        // オペランド B
    input  wire [7:0] in_f,        // 直前のフラグレジスタ (キャリー入力用)
    output reg  [7:0] out_res,     // 演算結果
    output reg  [7:0] out_f        // 演算後のフラグレジスタ (S, Z, Y, H, X, PV, N, C)
);

    wire carry_in = in_f[0]; // C flag

    // 内部演算用 9-bit ワイヤ
    reg [8:0] sum9;
    reg half_carry;
    reg overflow;
    reg [7:0] res;

    wire half_carry_add = ({1'b0, in_a[3:0]} + {1'b0, in_b[3:0]}) >= 5'd16;
    wire half_carry_adc = ({1'b0, in_a[3:0]} + {1'b0, in_b[3:0]} + {4'd0, carry_in}) >= 5'd16;

    // パリティ計算関数
    function parity8;
        input [7:0] d;
        begin
            parity8 = ~(d[0]^d[1]^d[2]^d[3]^d[4]^d[5]^d[6]^d[7]);
        end
    endfunction

    always @(*) begin
        sum9 = 9'h000;
        half_carry = 1'b0;
        overflow = 1'b0;
        res = 8'h00;
        out_f = in_f;

        case (alu_op)
            4'd0: begin // ADD
                sum9 = {1'b0, in_a} + {1'b0, in_b};
                res  = sum9[7:0];
                half_carry = half_carry_add;
                overflow   = ((in_a[7] == in_b[7]) && (res[7] != in_a[7]));
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b0, sum9[8]};
            end

            4'd1: begin // ADC
                sum9 = {1'b0, in_a} + {1'b0, in_b} + {8'h00, carry_in};
                res  = sum9[7:0];
                half_carry = half_carry_adc;
                overflow   = ((in_a[7] == in_b[7]) && (res[7] != in_a[7]));
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b0, sum9[8]};
            end

            4'd2: begin // SUB
                sum9 = {1'b0, in_a} - {1'b0, in_b};
                res  = sum9[7:0];
                half_carry = (in_a[3:0] < in_b[3:0]);
                overflow   = ((in_a[7] != in_b[7]) && (res[7] != in_a[7]));
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b1, sum9[8]};
            end

            4'd3: begin // SBC
                sum9 = {1'b0, in_a} - {1'b0, in_b} - {8'h00, carry_in};
                res  = sum9[7:0];
                half_carry = (in_a[3:0] < (in_b[3:0] + {3'b0, carry_in}));
                overflow   = ((in_a[7] != in_b[7]) && (res[7] != in_a[7]));
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b1, sum9[8]};
            end

            4'd4: begin // AND
                res = in_a & in_b;
                out_f = {res[7], (res == 8'h00), res[5], 1'b1, res[3], parity8(res), 1'b0, 1'b0};
            end

            4'd5: begin // XOR
                res = in_a ^ in_b;
                out_f = {res[7], (res == 8'h00), res[5], 1'b0, res[3], parity8(res), 1'b0, 1'b0};
            end

            4'd6: begin // OR
                res = in_a | in_b;
                out_f = {res[7], (res == 8'h00), res[5], 1'b0, res[3], parity8(res), 1'b0, 1'b0};
            end

            4'd7: begin // CP (Compare: A - in_b, but keep A unchanged)
                sum9 = {1'b0, in_a} - {1'b0, in_b};
                res  = in_a; // A stays unchanged
                half_carry = (in_a[3:0] < in_b[3:0]);
                overflow   = ((in_a[7] != in_b[7]) && (sum9[7] != in_a[7]));
                out_f = {sum9[7], (sum9[7:0] == 8'h00), in_b[5], half_carry, in_b[3], overflow, 1'b1, sum9[8]};
            end

            4'd8: begin // INC
                res = in_a + 8'd1;
                half_carry = (in_a[3:0] == 4'hF);
                overflow   = (in_a == 8'h7F);
                // INC preserves Carry flag!
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b0, in_f[0]};
            end

            4'd9: begin // DEC
                res = in_a - 8'd1;
                half_carry = (in_a[3:0] == 4'h0);
                overflow   = (in_a == 8'h80);
                // DEC preserves Carry flag!
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b1, in_f[0]};
            end

            default: begin
                res = in_a;
                out_f = in_f;
            end
        endcase

        out_res = res;
    end

endmodule
