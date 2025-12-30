<?php

// ==========================================
// 1. AST NODES
// ==========================================

class AST {}

class ProgramNode extends AST { 
    public $hardware; 
    public $vars; 
    public $db; 
    public $fc; 
    public $blocks = []; 
}

class Block extends AST { 
    public $statements = []; 
}

class VarDecl extends AST { 
    public $name, $type, $binding; 
    public function __construct($n, $t, $b=null) { 
        $this->name=$n; $this->type=$t; $this->binding=$b; 
    } 
}

class Assign extends AST { 
    public $left, $right; 
    public function __construct($l, $r) { 
        $this->left = $l; $this->right = $r; 
    } 
}

class FunctionCall extends AST { 
    public $name, $args; 
    public function __construct($n, $a) { 
        $this->name = $n; $this->args = $a; 
    } 
}

class BinOp extends AST { 
    public $left, $op, $right; 
    public function __construct($l, $o, $r) { 
        $this->left = $l; $this->op = $o; $this->right = $r; 
    } 
}

class Num extends AST { 
    public $value; 
    public function __construct($v) { $this->value = $v; } 
}

class Str extends AST { 
    public $value; 
    public function __construct($v) { $this->value = $v; } 
}

class VarNode extends AST { 
    public $name; 
    public function __construct($n) { $this->name = $n; } 
}

class IfNode extends AST { 
    public $condition, $thenBranch, $elseBranch; 
    public function __construct($c, $t, $e=null) { 
        $this->condition = $c; $this->thenBranch = $t; $this->elseBranch = $e; 
    } 
}

class WhileNode extends AST { 
    public $condition, $block; 
    public function __construct($c, $b) { 
        $this->condition = $c; $this->block = $b; 
    } 
}

class ForNode extends AST { 
    public $varName, $startExpr, $endExpr, $block; 
    public function __construct($v, $s, $e, $b) { 
        $this->varName=$v; $this->startExpr=$s; $this->endExpr=$e; $this->block=$b; 
    } 
}

// ==========================================
// 2. LEXER
// ==========================================

class Lexer {
    private $input, $pos = 0, $len;
    
    // KEYWORDS
    const T_HARDWARE='HARDWARE', T_END_HARDWARE='END_HARDWARE';
    const T_VAR='VAR', T_END_VAR='END_VAR';
    const T_DB='DB', T_END_DB='END_DB';
    const T_FC='FC', T_END_FC='END_FC';
    const T_BLOCK='BLOCK', T_END_BLOCK='END_BLOCK';
    
    const T_TYPE_INT='INT', T_TYPE_BOOL='BOOL';

    const T_INT='INT_VAL', T_STRING='STRING', T_BOOL='BOOL_VAL', T_ID='ID';
    const T_DOT='.', T_ASSIGN=':=', T_SEMI=';', T_COLON=':', T_LPAREN='(', T_RPAREN=')', T_COMMA=',', T_EOF='EOF';
    
    const T_PLUS='+', T_MINUS='-', T_MUL='*', T_DIV='/';
    const T_EQ='=', T_NEQ='<>', T_GT='>', T_LT='<';
    const T_AND='AND', T_OR='OR';
    
    const T_IF='IF', T_THEN='THEN', T_ELSIF='ELSIF', T_ELSE='ELSE', T_END_IF='END_IF';
    const T_WHILE='WHILE', T_DO='DO', T_END_WHILE='END_WHILE';
    const T_FOR='FOR', T_TO='TO', T_END_FOR='END_FOR';

    public function __construct($input) { 
        $this->input = $input; 
        $this->len = strlen($input); 
    }

    public function getNextToken() {
        while ($this->pos < $this->len) {
            $char = $this->input[$this->pos];
            
            // Skip whitespace
            if (ctype_space($char)) { $this->pos++; continue; }
            
            // Skip comments //
            if ($char == '/' && ($this->pos+1<$this->len) && $this->input[$this->pos+1] == '/') { 
                $this->pos+=2; 
                while($this->pos < $this->len && $this->input[$this->pos] != "\n") $this->pos++; 
                continue;
            }

            if (ctype_digit($char)) return new Token(self::T_INT, $this->readNum());
            if ($char == "'") return $this->readString();
            if (ctype_alpha($char) || $char == '_') return $this->readId();
            
            if ($char == '.') { $this->pos++; return new Token(self::T_DOT, '.'); }
            
            if ($char == ':' && $this->peek() == '=') { $this->pos+=2; return new Token(self::T_ASSIGN, ':='); }
            if ($char == '<' && $this->peek() == '>') { $this->pos+=2; return new Token(self::T_NEQ, '<>'); }
            
            $map = [
                ';'=>self::T_SEMI, ':'=>self::T_COLON, '('=>self::T_LPAREN, ')'=>self::T_RPAREN, ','=>self::T_COMMA, 
                '+'=>self::T_PLUS, '-'=>self::T_MINUS, '*'=>self::T_MUL, '/'=>self::T_DIV, 
                '='=>self::T_EQ, '>'=>self::T_GT, '<'=>self::T_LT
            ];
            
            if (isset($map[$char])) { $this->pos++; return new Token($map[$char], $char); }
            
            throw new Exception("Unknown char: $char");
        }
        return new Token(self::T_EOF, null);
    }

    private function peek() { 
        return ($this->pos + 1 < $this->len) ? $this->input[$this->pos+1] : null; 
    }

    private function readNum() { 
        $res=''; 
        while($this->pos<$this->len && ctype_digit($this->input[$this->pos])) $res.=$this->input[$this->pos++]; 
        return intval($res); 
    }

    private function readString() { 
        $this->pos++; $res=''; 
        while($this->pos<$this->len && $this->input[$this->pos]!="'") $res.=$this->input[$this->pos++]; 
        $this->pos++; 
        return new Token(self::T_STRING, $res); 
    }

    private function readId() {
        $res=''; 
        while($this->pos<$this->len && (ctype_alnum($this->input[$this->pos]) || $this->input[$this->pos]=='_')) $res.=$this->input[$this->pos++];
        
        $u = strtoupper($res);
        $k = [ 
            'HARDWARE'=>self::T_HARDWARE, 'END_HARDWARE'=>self::T_END_HARDWARE, 
            'VAR'=>self::T_VAR, 'END_VAR'=>self::T_END_VAR, 
            'DB'=>self::T_DB, 'END_DB'=>self::T_END_DB, 
            'FC'=>self::T_FC, 'END_FC'=>self::T_END_FC, 
            'BLOCK'=>self::T_BLOCK, 'END_BLOCK'=>self::T_END_BLOCK, 
            'INT'=>self::T_TYPE_INT, 'BOOL'=>self::T_TYPE_BOOL, 
            'IF'=>self::T_IF, 'THEN'=>self::T_THEN, 'ELSIF'=>self::T_ELSIF, 'ELSE'=>self::T_ELSE, 'END_IF'=>self::T_END_IF, 
            'TRUE'=>self::T_BOOL, 'FALSE'=>self::T_BOOL, 'AND'=>self::T_AND, 'OR'=>self::T_OR, 
            'WHILE'=>self::T_WHILE, 'DO'=>self::T_DO, 'END_WHILE'=>self::T_END_WHILE, 
            'FOR'=>self::T_FOR, 'TO'=>self::T_TO, 'END_FOR'=>self::T_END_FOR 
        ];
        
        return isset($k[$u]) ? new Token($k[$u], ($u=='TRUE'?true:($u=='FALSE'?false:$u))) : new Token(self::T_ID, $res);
    }
}

class Token { 
    public $type, $value; 
    public function __construct($t, $v) { $this->type=$t; $this->value=$v; } 
}

// ==========================================
// 3. PARSER
// ==========================================

class Parser {
    private $lexer, $curr;

    public function __construct($l) { 
        $this->lexer = $l; 
        $this->curr = $l->getNextToken(); 
    }

    private function eat($t) { 
        if ($this->curr->type == $t) $this->curr = $this->lexer->getNextToken(); 
        else throw new Exception("Expected $t, got {$this->curr->type}"); 
    }

    public function parse() {
        $prog = new ProgramNode();
        while ($this->curr->type != Lexer::T_EOF) {
            if ($this->curr->type == Lexer::T_VAR) $prog->vars = $this->parseVarSection();
            elseif ($this->curr->type == Lexer::T_HARDWARE) $prog->hardware = $this->parseSection(Lexer::T_HARDWARE, Lexer::T_END_HARDWARE);
            elseif ($this->curr->type == Lexer::T_DB) $prog->db = $this->parseSection(Lexer::T_DB, Lexer::T_END_DB);
            elseif ($this->curr->type == Lexer::T_FC) $prog->fc = $this->parseSection(Lexer::T_FC, Lexer::T_END_FC);
            elseif ($this->curr->type == Lexer::T_BLOCK) {
                $this->eat(Lexer::T_BLOCK); 
                $name = $this->curr->value; 
                $this->eat(Lexer::T_ID);
                $blockNode = $this->block([Lexer::T_END_BLOCK]);
                $this->eat(Lexer::T_END_BLOCK);
                $prog->blocks[strtoupper($name)] = $blockNode;
            }
            else throw new Exception("Unexpected token: " . $this->curr->type);
        }
        return $prog;
    }

    private function parseVarSection() {
        $this->eat(Lexer::T_VAR);
        $vars = [];
        while ($this->curr->type != Lexer::T_END_VAR && $this->curr->type != Lexer::T_EOF) {
            $name = $this->curr->value; 
            $this->eat(Lexer::T_ID); 
            $this->eat(Lexer::T_COLON);
            
            if ($this->curr->type == Lexer::T_TYPE_INT || $this->curr->type == Lexer::T_TYPE_BOOL) {
                $type = $this->curr->type; 
                $this->eat($type); 
                $vars[] = new VarDecl($name, $type);
            } elseif ($this->curr->type == Lexer::T_ID) {
                $devName = $this->curr->value; $this->eat(Lexer::T_ID); $this->eat(Lexer::T_DOT);
                $ioType = $this->curr->value; $this->eat(Lexer::T_ID); $this->eat(Lexer::T_DOT);
                $addr = $this->curr->value; $this->eat(Lexer::T_INT);
                $vars[] = new VarDecl($name, 'BINDING', ['dev' => $devName, 'io' => $ioType, 'addr' => $addr]);
            }
            $this->eat(Lexer::T_SEMI);
        }
        $this->eat(Lexer::T_END_VAR);
        return $vars;
    }
    
    private function parseSection($s, $e) { 
        $this->eat($s); 
        $b=$this->block([$e]); 
        $this->eat($e); 
        return $b; 
    }

    private function block($stops) { 
        $n=new Block(); 
        while(!in_array($this->curr->type, $stops) && $this->curr->type!=Lexer::T_EOF) { 
            if($s=$this->statement()) $n->statements[]=$s; 
        } 
        return $n; 
    }
    
    private function statement() {
        if ($this->curr->type == Lexer::T_ID) {
            $name=$this->curr->value; $this->eat(Lexer::T_ID);
            if ($this->curr->type == Lexer::T_ASSIGN) { 
                $this->eat(Lexer::T_ASSIGN); 
                $e=$this->expr(); 
                $this->eat(Lexer::T_SEMI); 
                return new Assign(new VarNode($name), $e); 
            }
            elseif ($this->curr->type == Lexer::T_LPAREN) { 
                $a=$this->argList(); 
                $this->eat(Lexer::T_SEMI); 
                return new FunctionCall($name, $a); 
            }
        } elseif ($this->curr->type == Lexer::T_IF) {
            // NEW: Updated Logic for IF / ELSIF / ELSE IF
            return $this->parseIfChain();
        } elseif ($this->curr->type == Lexer::T_WHILE) {
            $this->eat(Lexer::T_WHILE); 
            $c=$this->expr(); 
            $this->eat(Lexer::T_DO); 
            $b=$this->block([Lexer::T_END_WHILE]); 
            $this->eat(Lexer::T_END_WHILE); 
            $this->eat(Lexer::T_SEMI); 
            return new WhileNode($c,$b);
        } elseif ($this->curr->type == Lexer::T_FOR) {
            $this->eat(Lexer::T_FOR); 
            $v=$this->curr->value; 
            $this->eat(Lexer::T_ID); 
            $this->eat(Lexer::T_ASSIGN); 
            $s=$this->expr(); 
            $this->eat(Lexer::T_TO); 
            $e=$this->expr(); 
            $this->eat(Lexer::T_DO); 
            $b=$this->block([Lexer::T_END_FOR]); 
            $this->eat(Lexer::T_END_FOR); 
            $this->eat(Lexer::T_SEMI); 
            return new ForNode($v,$s,$e,$b);
        }
        if ($this->curr->type!=Lexer::T_EOF) $this->eat($this->curr->type); 
        return null;
    }

    // --- NEW: Helper for Recursive IF/ELSIF Parsing ---
    private function parseIfChain() {
        $this->eat(Lexer::T_IF);
        $condition = $this->expr();
        $this->eat(Lexer::T_THEN);
        
        $thenBranch = $this->block([Lexer::T_ELSIF, Lexer::T_ELSE, Lexer::T_END_IF]);
        $elseBranch = null;

        if ($this->curr->type == Lexer::T_ELSIF) {
            $this->eat(Lexer::T_ELSIF);
            $elseBranch = $this->parseElsifBody();
        } elseif ($this->curr->type == Lexer::T_ELSE) {
            $this->eat(Lexer::T_ELSE);
            if ($this->curr->type == Lexer::T_IF) { // Handles "ELSE IF" space separated
                $this->eat(Lexer::T_IF);
                $elseBranch = $this->parseElsifBody();
            } else {
                $elseBranch = $this->block([Lexer::T_END_IF]);
                $this->eat(Lexer::T_END_IF);
            }
        } else {
            $this->eat(Lexer::T_END_IF);
        }
        $this->eat(Lexer::T_SEMI);
        return new IfNode($condition, $thenBranch, $elseBranch);
    }

    // Parses the body of an ELSIF recursively
    private function parseElsifBody() {
        $condition = $this->expr();
        $this->eat(Lexer::T_THEN);
        $thenBranch = $this->block([Lexer::T_ELSIF, Lexer::T_ELSE, Lexer::T_END_IF]);
        $elseBranch = null;

        if ($this->curr->type == Lexer::T_ELSIF) {
            $this->eat(Lexer::T_ELSIF);
            $elseBranch = $this->parseElsifBody();
        } elseif ($this->curr->type == Lexer::T_ELSE) {
            $this->eat(Lexer::T_ELSE);
            if ($this->curr->type == Lexer::T_IF) {
                $this->eat(Lexer::T_IF);
                $elseBranch = $this->parseElsifBody();
            } else {
                $elseBranch = $this->block([Lexer::T_END_IF]);
                $this->eat(Lexer::T_END_IF);
            }
        } else {
            $this->eat(Lexer::T_END_IF);
        }
        
        // Wrap nested IF in a Block so the Interpreter can handle it uniformly
        $wrapper = new Block();
        $wrapper->statements[] = new IfNode($condition, $thenBranch, $elseBranch);
        return $wrapper;
    }

    private function argList() { 
        $a=[]; $this->eat(Lexer::T_LPAREN); 
        if($this->curr->type!=Lexer::T_RPAREN){ 
            $a[]=$this->expr(); 
            while($this->curr->type==Lexer::T_COMMA){ 
                $this->eat(Lexer::T_COMMA); 
                $a[]=$this->expr(); 
            } 
        } 
        $this->eat(Lexer::T_RPAREN); 
        return $a; 
    }

    // --- NEW: Operator Precedence Hierarchy ---
    // 1. Lowest Precedence: OR
    private function expr() { 
        $n = $this->logicAnd(); 
        while($this->curr->type == Lexer::T_OR) { 
            $t=$this->curr; $this->eat(Lexer::T_OR); 
            $n=new BinOp($n,$t,$this->logicAnd()); 
        } 
        return $n; 
    }

    // 2. Next: AND
    private function logicAnd() { 
        $n = $this->relation(); 
        while($this->curr->type == Lexer::T_AND) { 
            $t=$this->curr; $this->eat(Lexer::T_AND); 
            $n=new BinOp($n,$t,$this->relation()); 
        } 
        return $n; 
    }

    // 3. Next: Comparison (=, <>, >, <)
    private function relation() {
        $n = $this->simpleExpr();
        while(in_array($this->curr->type, [Lexer::T_EQ, Lexer::T_NEQ, Lexer::T_GT, Lexer::T_LT])) {
            $t=$this->curr; $this->eat($t->type); 
            $n=new BinOp($n,$t,$this->simpleExpr());
        }
        return $n;
    }

    // 4. Next: Addition / Subtraction
    private function simpleExpr() {
        $n = $this->term();
        while(in_array($this->curr->type, [Lexer::T_PLUS, Lexer::T_MINUS])) {
            $t=$this->curr; $this->eat($t->type); 
            $n=new BinOp($n,$t,$this->term());
        }
        return $n;
    }

    // 5. Highest: Multiplication / Division
    private function term() { 
        $n=$this->factor(); 
        while(in_array($this->curr->type,[Lexer::T_MUL,Lexer::T_DIV])) { 
            $t=$this->curr; $this->eat($t->type); 
            $n=new BinOp($n,$t,$this->factor()); 
        } 
        return $n; 
    }
    
    private function factor() {
        $t=$this->curr; 
        if($t->type==Lexer::T_MINUS){ $this->eat(Lexer::T_MINUS); return new BinOp(new Num(0),new Token(Lexer::T_MINUS,'-'),$this->factor()); }
        if($t->type==Lexer::T_INT||$t->type==Lexer::T_BOOL){ $this->eat($t->type); return new Num($t->value); }
        if($t->type==Lexer::T_STRING){ $this->eat($t->type); return new Str($t->value); }
        if($t->type==Lexer::T_ID){ 
            $n=$t->value; $this->eat(Lexer::T_ID); 
            if($this->curr->type==Lexer::T_LPAREN) return new FunctionCall($n,$this->argList()); 
            return new VarNode($n); 
        }
        if($t->type==Lexer::T_LPAREN){ 
            $this->eat(Lexer::T_LPAREN); $n=$this->expr(); $this->eat(Lexer::T_RPAREN); return $n; 
        }
        throw new Exception("Unexpected token in factor: ".$t->value);
    }
}

// ==========================================
// 4. INTERPRETER
// ==========================================

class Interpreter {
    public $memory = [];
    public $bindings = []; 
    private $funcs = [];
    private $sclBlocks = [];
    private $hwHandler = null;

    public function register($n, $cb) { 
        $this->funcs[strtoupper($n)] = $cb; 
    }
    
    public function setHardwareHandler($cb) { 
        $this->hwHandler = $cb; 
    }

    public function run(ProgramNode $prog) {
        $this->sclBlocks = $prog->blocks;
        
        if ($prog->vars) {
            foreach ($prog->vars as $v) {
                if ($v->type == 'BINDING') {
                    $this->bindings[$v->name] = $v->binding; 
                    $this->memory[$v->name] = false;
                } else {
                    $this->memory[$v->name] = ($v->type == Lexer::T_TYPE_INT) ? 0 : false;
                }
            }
        }
        if ($prog->hardware) $this->visit($prog->hardware);
        if ($prog->db) $this->visit($prog->db);
        if ($prog->fc) $this->visit($prog->fc);
    }

    public function visitFunctionCall($n) {
        $name = strtoupper($n->name);

        // 1. PHP Native Function
        if (isset($this->funcs[$name])) {
            $args = array_map([$this, 'visit'], $n->args);
            return call_user_func_array($this->funcs[$name], $args);
        }

        // 2. Custom SCL Block
        if (isset($this->sclBlocks[$name])) {
            return $this->visit($this->sclBlocks[$name]);
        }

        throw new Exception("Unknown Function or Block: $name");
    }

    public function visitAssign($n) { 
        $val = $this->visit($n->right); 
        $varName = $n->left->name; 
        $this->memory[$varName] = $val; 
        
        if (isset($this->bindings[$varName]) && $this->hwHandler) {
            $b = $this->bindings[$varName]; 
            $handle = $this->memory[$b['dev']];
            call_user_func($this->hwHandler, 'WRITE', $handle, $b['io'], $b['addr'], $val);
        }
    }

    public function visitVarNode($n) { 
        $varName = $n->name;
        if (isset($this->bindings[$varName]) && $this->hwHandler) {
            $b = $this->bindings[$varName]; 
            $handle = $this->memory[$b['dev']];
            $hwVal = call_user_func($this->hwHandler, 'READ', $handle, $b['io'], $b['addr'], null);
            if ($hwVal !== null) $this->memory[$varName] = $hwVal;
        }
        return isset($this->memory[$varName]) ? $this->memory[$varName] : 0; 
    }

    public function visit($n) { 
        if(!$n)return; 
        $m='visit'.get_class($n); 
        return $this->$m($n); 
    }

    public function visitBlock($n) { 
        foreach($n->statements as $s) $this->visit($s); 
    }
    
    public function visitNum($n) { return $n->value; }
    public function visitStr($n) { return $n->value; }

    public function visitWhileNode($n) { 
        while ($this->visit($n->condition)) $this->visit($n->block); 
    }

    public function visitIfNode($n) { 
        if ($this->visit($n->condition)) {
            $this->visit($n->thenBranch);
        } elseif($n->elseBranch) {
            $this->visit($n->elseBranch); 
        }
    }

    public function visitForNode($n) { 
        $var=$n->varName; 
        $start=$this->visit($n->startExpr); 
        $end=$this->visit($n->endExpr); 
        $this->memory[$var]=$start; 
        while($this->memory[$var]<=$end){ 
            $this->visit($n->block); 
            $this->memory[$var]++; 
        } 
    }

    public function visitBinOp($n) { 
        $l = $this->visit($n->left); 
        $r = $this->visit($n->right); 
        switch($n->op->type) { 
            case Lexer::T_PLUS: return $l+$r; 
            case Lexer::T_MINUS: return $l-$r; 
            case Lexer::T_MUL: return $l*$r; 
            case Lexer::T_DIV: return $l/$r; 
            case Lexer::T_EQ: return $l==$r; 
            case Lexer::T_NEQ: return $l!=$r; 
            case Lexer::T_GT: return $l>$r; 
            case Lexer::T_LT: return $l<$r; 
            case Lexer::T_AND: return $l&&$r; 
            case Lexer::T_OR: return $l||$r; 
        } 
    }
}